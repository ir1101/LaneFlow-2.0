"""Triggered by SQS. Starts one Step Functions execution per queued job."""
import json
import os

import boto3

from common import TABLE, record_cost, start_timer

sfn = boto3.client("stepfunctions")
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]


def handler(event, context):
    failures = []
    for record in event["Records"]:
        started = start_timer()
        try:
            job = json.loads(record["body"])
            # The execution is named after the document ID. SQS can deliver a message
            # twice and Express workflows do not reject duplicate names, so a document
            # may occasionally run twice. That is safe: every write uses the document ID
            # as its key, so a repeat run overwrites the same records (idempotent).
            execution_arn = sfn.start_execution(stateMachineArn=STATE_MACHINE_ARN,
                                                name=job["docId"],
                                                input=json.dumps(job))["executionArn"]
            TABLE.update_item(
                Key={"pk": job["docId"], "sk": "JOB"},
                UpdateExpression="SET #s = :s, executionArn = :e",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "STARTED", ":e": execution_arn},
            )
            record_cost(job["docId"], "dispatcher", context, started, ddb_writes=1,
                        sqs_requests=1, extra={"mode": job["mode"]})
        except Exception as exc:  # report this message as failed so SQS retries it
            print(f"Failed to dispatch {record['messageId']}: {exc}")
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
