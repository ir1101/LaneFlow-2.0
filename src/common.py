"""Shared helpers: per-invocation cost records written to DynamoDB."""
import json
import math
import os
import time
from decimal import Decimal

import boto3

# On-demand prices for ap-southeast-2 (Sydney), taken from the AWS Price List API
# on 2026-10-16. Lambda figures are for arm64 (Graviton), first pricing tier.
PRICES = {
    "lambda_gb_second": 0.0000133334,
    "lambda_request": 0.0000002,
    "s3_put": 0.0000055,      # Tier 1 requests (PUT, COPY, POST, LIST)
    "s3_get": 0.00000044,     # Tier 2 requests (GET and others)
    "ddb_write": 0.00000071,  # one on-demand write request unit
    "sqs_request": 0.0000004,
}

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])

# Lambda runs module-level code once per new execution environment (a "cold start").
_COLD = True


def start_timer():
    return time.perf_counter()


def to_dynamo(item):
    """DynamoDB rejects Python floats, so round-trip through JSON into Decimal."""
    return json.loads(json.dumps(item), parse_float=Decimal)


def record_cost(doc_id, component, context, started, s3_gets=0, s3_puts=0,
                ddb_writes=0, sqs_requests=0, extra=None):
    """Write one cost record for this invocation and return it.

    measuredMs is timed inside the handler. Lambda bills in 1 ms steps, so the
    estimate is the measured time rounded up. The exact Billed Duration from the
    Lambda REPORT log line is reconciled later using requestId.
    """
    global _COLD
    measured_ms = (time.perf_counter() - started) * 1000
    billed_ms = math.ceil(measured_ms)
    memory_mb = int(context.memory_limit_in_mb)
    gb_seconds = (memory_mb / 1024) * (billed_ms / 1000)
    ddb_writes += 1  # this cost record is itself a DynamoDB write

    compute = gb_seconds * PRICES["lambda_gb_second"]
    request = PRICES["lambda_request"]
    storage_ops = (s3_gets * PRICES["s3_get"] + s3_puts * PRICES["s3_put"]
                   + ddb_writes * PRICES["ddb_write"] + sqs_requests * PRICES["sqs_request"])

    item = {
        "pk": doc_id,
        "sk": f"COST#{component}",
        "component": component,
        "functionName": context.function_name,
        "requestId": context.aws_request_id,
        "memoryMb": memory_mb,
        "measuredMs": round(measured_ms, 3),
        "billedMsEstimate": billed_ms,
        "gbSeconds": gb_seconds,
        "coldStart": _COLD,
        "s3Gets": s3_gets,
        "s3Puts": s3_puts,
        "ddbWrites": ddb_writes,
        "sqsRequests": sqs_requests,
        "computeUsd": compute,
        "requestUsd": request,
        "storageOpsUsd": storage_ops,
        "totalUsd": compute + request + storage_ops,
        "recordedAt": int(time.time()),
    }
    if extra:
        item.update(extra)
    TABLE.put_item(Item=to_dynamo(item))
    _COLD = False
    return item
