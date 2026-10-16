"""Replaces each cost estimate with the duration AWS actually billed.

Triggered by a CloudWatch Logs subscription on every pipeline function's log group.
Each Lambda invocation ends with a REPORT line such as:
  REPORT RequestId: abc  Duration: 182.4 ms  Billed Duration: 183 ms  Memory Size: 512 MB ...
The request ID links that line to the cost record the function wrote, through the
byRequestId index on the table. The record is updated with the actual figures, and the
document's COST#TOTAL record accumulates the per-document total.
"""
import base64
import gzip
import json
import os
import re
import time

import boto3
from botocore.exceptions import ClientError

from tracing import tracer
from common import PRICES

dynamodb = boto3.client("dynamodb")
TABLE_NAME = os.environ["TABLE_NAME"]
INDEX_NAME = "byRequestId"
REPORT_RE = re.compile(r"RequestId: (\S+)\s+Duration: [\d.]+ ms\s+Billed Duration: (\d+) ms\s+"
                       r"Memory Size: (\d+) MB(?:.*?Init Duration: ([\d.]+) ms)?", re.S)


def num(x):
    """DynamoDB numbers travel as strings; fixed-point keeps very small costs readable."""
    return {"N": f"{x:.12f}"}


def find_cost_records(request_id):
    # The index is updated asynchronously, so allow a moment for a just-written record.
    for attempt in range(4):
        items = dynamodb.query(TableName=TABLE_NAME, IndexName=INDEX_NAME,
                               KeyConditionExpression="requestId = :r",
                               ExpressionAttributeValues={":r": {"S": request_id}})["Items"]
        if items:
            return items
        time.sleep(0.5 * (attempt + 1))
    return []


def reconcile(item, billed_ms, memory_mb, init_ms):
    pk, sk = item["pk"]["S"], item["sk"]["S"]
    compute = memory_mb / 1024 * billed_ms / 1000 * PRICES["lambda_gb_second"]
    lambda_usd = compute + PRICES["lambda_request"]
    storage_usd = float(item["storageOpsUsd"]["N"])
    total = lambda_usd + storage_usd
    production = total - PRICES["ddb_write"]  # the cost record's own write is measurement
    now = {"N": str(int(time.time()))}
    try:
        # The condition makes this idempotent: a redelivered log batch changes nothing.
        dynamodb.update_item(
            TableName=TABLE_NAME, Key={"pk": {"S": pk}, "sk": {"S": sk}},
            UpdateExpression="SET billedMsActual = :b, initMsActual = :i, computeUsdActual = :c, "
                             "totalUsdActual = :t, productionUsdActual = :p, reconciledAt = :n",
            ConditionExpression="attribute_not_exists(billedMsActual)",
            ExpressionAttributeValues={":b": {"N": str(billed_ms)}, ":i": num(init_ms),
                                       ":c": num(compute), ":t": num(total),
                                       ":p": num(production), ":n": now})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    dynamodb.update_item(
        TableName=TABLE_NAME, Key={"pk": {"S": pk}, "sk": {"S": "COST#TOTAL"}},
        UpdateExpression="ADD lambdaUsd :l, storageOpsUsd :s, totalUsd :t, productionUsd :p, "
                         "billedMs :b, invocations :one SET updatedAt = :n",
        ExpressionAttributeValues={":l": num(lambda_usd), ":s": num(storage_usd), ":t": num(total),
                                   ":p": num(production), ":b": {"N": str(billed_ms)},
                                   ":one": {"N": "1"}, ":n": now})
    # Embedded Metric Format: CloudWatch turns this log line into a custom metric,
    # so the dashboard can chart cost per invocation without extra API calls.
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000),
                 "CloudWatchMetrics": [{"Namespace": "LaneFlow", "Dimensions": [["Component"]],
                                        "Metrics": [{"Name": "InvocationCostUsd", "Unit": "None"}]}]},
        "Component": item["component"]["S"],
        "InvocationCostUsd": production,
        "docId": pk,
    }))


@tracer.capture_lambda_handler
def handler(event, context):
    payload = json.loads(gzip.decompress(base64.b64decode(event["awslogs"]["data"])))
    for log_event in payload["logEvents"]:
        match = REPORT_RE.search(log_event["message"])
        if not match:
            continue
        request_id = match.group(1)
        billed_ms, memory_mb = int(match.group(2)), int(match.group(3))
        init_ms = float(match.group(4) or 0)
        items = find_cost_records(request_id)
        if not items:
            # Expected only if a function failed before it could write a cost record.
            print(f"No cost record for {request_id} in {payload['logGroup']}")
            continue
        # One invocation normally writes one cost record; if it wrote several, split evenly.
        for item in items:
            reconcile(item, billed_ms / len(items), memory_mb, init_ms / len(items))
