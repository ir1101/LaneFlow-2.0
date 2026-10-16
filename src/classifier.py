"""Scores a PDF's complexity and picks a lane."""
import io
import os

import boto3
from pypdf import PdfReader

from common import record_cost, start_timer

s3 = boto3.client("s3")
LIGHT_MAX_SCORE = float(os.environ.get("LIGHT_MAX_SCORE", 30))


def handler(event, context):
    started = start_timer()
    ops = {"s3_gets": 0}
    extra = {"mode": event["mode"], "failed": True}
    try:
        data = s3.get_object(Bucket=event["bucket"], Key=event["key"])["Body"].read()
        ops["s3_gets"] += 1
        pages = len(PdfReader(io.BytesIO(data)).pages)
        size_mb = len(data) / (1024 * 1024)

        # Page count drives text-extraction time most strongly; size adds weight for
        # image-heavy files. One megabyte counts the same as ten pages.
        score = pages + 10 * size_mb
        lane = "light" if score <= LIGHT_MAX_SCORE else "heavy"
        extra.update({"failed": False, "lane": lane, "pages": pages, "score": round(score, 2)})
        return {**event, "pages": pages, "sizeMb": round(size_mb, 3),
                "score": round(score, 2), "lane": lane}
    finally:
        # Runs on success and on failure, so failed documents are costed too.
        record_cost(event["docId"], "classifier", context, started, extra=extra, **ops)
