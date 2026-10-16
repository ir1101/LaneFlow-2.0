"""X-Ray tracing for every LaneFlow function, using Powertools for AWS Lambda (Lambda layer).

Only AWS SDK calls are patched, so each S3, DynamoDB, SQS, SNS and Step Functions call shows
up as its own subsegment of the function's trace. Annotations are indexed by X-Ray, so one
document's trace can be found in CloudWatch with the filter  annotation.docId = "<id>".
"""
import os

from aws_lambda_powertools import Tracer

tracer = Tracer(patch_modules=["botocore"])


def sampled_trace_id():
    """The current X-Ray trace ID if this invocation is being recorded, otherwise None."""
    header = os.environ.get("_X_AMZN_TRACE_ID", "")
    parts = dict(p.split("=", 1) for p in header.split(";") if "=" in p)
    return parts.get("Root") if parts.get("Sampled") == "1" else None


def annotate(**values):
    """Attach searchable annotations (skipping empty values) to the current trace."""
    for key, value in values.items():
        if value is not None:
            tracer.put_annotation(key=key, value=value)
