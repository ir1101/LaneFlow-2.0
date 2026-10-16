"""Extracts text and metadata. Deployed three times with different memory sizes."""
import io
import os
import time

import boto3
from pypdf import PdfReader

from common import TABLE, record_cost, start_timer, to_dynamo

s3 = boto3.client("s3")
LANE = os.environ["LANE"]  # light, heavy or baseline
CURATED_BUCKET = os.environ["CURATED_BUCKET"]


def handler(event, context):
    started = start_timer()
    ops = {"s3_gets": 0, "s3_puts": 0, "ddb_writes": 0}
    extra = {"mode": event["mode"], "lane": LANE, "failed": True}
    try:
        data = s3.get_object(Bucket=event["bucket"], Key=event["key"])["Body"].read()
        ops["s3_gets"] += 1
        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
        meta = reader.metadata or {}
        pages = len(reader.pages)
        words = len(text.split())

        s3.put_object(Bucket=CURATED_BUCKET, Key=f"text/{event['docId']}.txt",
                      Body=text.encode("utf-8"), ContentType="text/plain; charset=utf-8")
        ops["s3_puts"] += 1

        TABLE.put_item(Item=to_dynamo({
            "pk": event["docId"],
            "sk": "RESULT",
            "sourceKey": event["key"],
            "mode": event["mode"],
            "lane": LANE,
            "pages": pages,
            "words": words,
            "characters": len(text),
            "hasTextLayer": words > 0,
            "title": str(meta.get("/Title", "") or ""),
            "author": str(meta.get("/Author", "") or ""),
            "textObject": f"s3://{CURATED_BUCKET}/text/{event['docId']}.txt",
            "processedAt": int(time.time()),
        }))
        ops["ddb_writes"] += 1
        extra.update({"failed": False, "pages": pages, "sizeBytes": len(data)})
        return {**event, "lane": LANE, "pages": pages, "words": words}
    finally:
        # Runs on success and on failure, so failed documents are costed too.
        record_cost(event["docId"], f"extract-{LANE}", context, started, extra=extra, **ops)
