"""Triggered by S3 uploads. Checks the file is a real PDF, then queues a job."""
import json
import os
import re
import time
import uuid
from urllib.parse import unquote_plus

import boto3

from common import TABLE, record_cost, start_timer, to_dynamo

s3 = boto3.client("s3")
sqs = boto3.client("sqs")
sns = boto3.client("sns")

MAX_BYTES = int(os.environ.get("MAX_BYTES", 25 * 1024 * 1024))
# Website uploads are stored as <mode>/<docId>/<file name>, so the browser already knows the ID.
WEB_KEY = re.compile(r"^(?:adaptive|baseline)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                     r"[0-9a-f]{4}-[0-9a-f]{12})/")


def handler(event, context):
    for record in event["Records"]:
        started = start_timer()
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])
        if key.startswith("tuning/"):
            continue  # inputs for memory tuning, not documents to process
        size = record["s3"]["object"].get("size", 0)
        web_upload = WEB_KEY.match(key)
        doc_id = web_upload.group(1) if web_upload else str(uuid.uuid4())
        # Files under baseline/ go through the single over-provisioned function,
        # everything else through adaptive routing.
        mode = "baseline" if key.startswith("baseline/") else "adaptive"
        gets = 0

        reason = None
        if not key.lower().endswith(".pdf"):
            reason = "file name does not end in .pdf"
        elif size == 0:
            reason = "file is empty"
        elif size > MAX_BYTES:
            reason = f"file is larger than {MAX_BYTES} bytes"
        else:
            # Read only the first 5 bytes: every genuine PDF starts with "%PDF-".
            head = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-4")["Body"].read()
            gets += 1
            if not head.startswith(b"%PDF"):
                reason = "file content is not a PDF"

        job = {"docId": doc_id, "bucket": bucket, "key": key, "sizeBytes": size, "mode": mode}
        # The job record is written before the message is queued. Otherwise the dispatcher
        # can pick the job up and record its execution first, and this write would then
        # overwrite that record (a race condition found during testing).
        TABLE.put_item(Item=to_dynamo({"pk": doc_id, "sk": "JOB", **job,
                                       "status": "REJECTED" if reason else "QUEUED",
                                       "rejectReason": reason, "createdAt": int(time.time())}))
        if reason:
            sns.publish(TopicArn=os.environ["TOPIC_ARN"], Subject="LaneFlow: upload rejected",
                        Message=f"{key} was rejected: {reason}",
                        MessageAttributes={"outcome": {"DataType": "String",
                                                       "StringValue": "rejected"}})
        else:
            sqs.send_message(QueueUrl=os.environ["QUEUE_URL"], MessageBody=json.dumps(job))
        record_cost(doc_id, "validator", context, started, s3_gets=gets, ddb_writes=1,
                    sqs_requests=0 if reason else 1, extra={"mode": mode})
