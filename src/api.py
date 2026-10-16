"""HTTP API behind the LaneFlow website: upload links, document progress and recent activity.

Routes (served through CloudFront under /api):
  POST /api/uploads                   short-lived, PDF-only upload form for the upload bucket
  GET  /api/documents?limit=25        most recent documents with status, lane and billed cost
  GET  /api/documents/{docId}         one document's progress and per-function costs
  GET  /api/documents/{docId}/text    short-lived link to the extracted text
  GET  /api/health                    liveness check for the status indicator
"""
import base64
import json
import os
import re
import uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

from tracing import annotate, tracer

REGION = os.environ["AWS_REGION"]
UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
CURATED_BUCKET = os.environ["CURATED_BUCKET"]
MAX_BYTES = 25 * 1024 * 1024
LINK_SECONDS = 300

# A regional, virtual-hosted endpoint avoids a redirect that would break browser uploads.
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com",
                  config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
DOC_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
COMPONENT_ORDER = ["validator", "dispatcher", "classifier", "extract-light", "extract-heavy",
                   "extract-baseline"]


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Cannot serialise {type(value).__name__}")


def respond(status, body):
    return {"statusCode": status,
            "headers": {"content-type": "application/json", "cache-control": "no-store"},
            "body": json.dumps(body, default=_plain)}


@tracer.capture_lambda_handler
def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    params = event.get("pathParameters") or {}
    annotate(route=event.get("routeKey"), docId=params.get("docId"))
    try:
        if method == "POST" and path == "/api/uploads":
            raw = event.get("body") or "{}"
            if event.get("isBase64Encoded"):
                raw = base64.b64decode(raw).decode("utf-8")
            return create_upload(json.loads(raw))
        if method == "GET" and path == "/api/documents":
            return list_documents(event.get("queryStringParameters") or {})
        if method == "GET" and "docId" in params and path.endswith("/text"):
            return text_link(params["docId"])
        if method == "GET" and "docId" in params:
            return get_document(params["docId"])
        if method == "GET" and path == "/api/health":
            return respond(200, {"ok": True, "region": REGION})
        return respond(404, {"error": "Not found."})
    except (ValueError, json.JSONDecodeError) as exc:
        return respond(400, {"error": str(exc)})


def create_upload(body):
    mode = body.get("mode", "adaptive")
    if mode not in ("adaptive", "baseline"):
        raise ValueError("Mode must be adaptive or baseline.")
    name = str(body.get("filename", "")).replace("\\", "/").rsplit("/", 1)[-1]
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:80] or "document.pdf"
    if not safe.lower().endswith(".pdf"):
        raise ValueError("Only .pdf files can be uploaded.")

    # The document ID travels inside the object key, so the validator reuses it and the
    # browser can follow its document from the moment it is uploaded.
    doc_id = str(uuid.uuid4())
    key = f"{mode}/{doc_id}/{safe}"
    form = s3.generate_presigned_post(
        UPLOAD_BUCKET, key,
        Fields={"Content-Type": "application/pdf"},
        Conditions=[{"Content-Type": "application/pdf"}, ["content-length-range", 1, MAX_BYTES]],
        ExpiresIn=LINK_SECONDS)
    return respond(201, {"docId": doc_id, "key": key, "upload": form, "maxBytes": MAX_BYTES})


def batch_get(keys):
    """Fetch many (pk, sk) items, 100 keys per request, retrying any unprocessed keys."""
    found = {}
    for start in range(0, len(keys), 100):
        request = {table.name: {"Keys": [{"pk": pk, "sk": sk} for pk, sk in keys[start:start + 100]]}}
        while request:
            response = table.meta.client.batch_get_item(RequestItems=request)
            for item in response["Responses"].get(table.name, []):
                found[(item["pk"], item["sk"])] = item
            request = response.get("UnprocessedKeys") or None
    return found


def summarise(job, result=None, total=None):
    result, total = result or {}, total or {}
    return {
        "docId": job["pk"],
        "file": job["key"].rsplit("/", 1)[-1],
        "mode": job.get("mode"),
        "status": job.get("status"),
        "lane": job.get("lane") or result.get("lane"),
        "pages": result.get("pages", job.get("pages")),
        "words": result.get("words"),
        "sizeBytes": job.get("sizeBytes"),
        "createdAt": job.get("createdAt"),
        "completedAt": job.get("completedAt"),
        "error": job.get("errorType") or job.get("rejectReason"),
        "costUsd": total.get("productionUsd"),
        "billedMs": total.get("billedMs"),
        "invocations": total.get("invocations"),
        "traceId": job.get("traceId"),
    }


def list_documents(query):
    try:
        limit = max(1, min(int(query.get("limit", 25)), 100))
    except ValueError:
        raise ValueError("limit must be a whole number.")
    jobs = table.query(IndexName="byCreatedAt", KeyConditionExpression=Key("sk").eq("JOB"),
                       ScanIndexForward=False, Limit=limit)["Items"]
    extra = batch_get([(job["pk"], sk) for job in jobs for sk in ("RESULT", "COST#TOTAL")])
    return respond(200, {"documents": [
        summarise(job, extra.get((job["pk"], "RESULT")), extra.get((job["pk"], "COST#TOTAL")))
        for job in jobs]})


def get_document(doc_id):
    if not DOC_ID.match(doc_id):
        raise ValueError("That is not a valid document ID.")
    items = {item["sk"]: item for item in
             table.query(KeyConditionExpression=Key("pk").eq(doc_id))["Items"]}
    if "JOB" not in items:
        return respond(404, {"error": "Not registered yet.", "docId": doc_id})

    components = []
    for sk, item in items.items():
        if not sk.startswith("COST#") or sk == "COST#TOTAL":
            continue
        components.append({
            "component": item["component"],
            "memoryMb": item.get("memoryMb"),
            "billedMs": item.get("billedMsActual"),
            "estimateMs": item.get("billedMsEstimate"),
            "costUsd": item.get("productionUsdActual"),
            "coldStart": bool(item.get("initMsActual", 0)),
            "reconciled": "billedMsActual" in item,
            "failed": bool(item.get("failed", False)),
            "score": item.get("score"),
            "lane": item.get("lane"),
        })
    components.sort(key=lambda c: COMPONENT_ORDER.index(c["component"])
                    if c["component"] in COMPONENT_ORDER else 99)
    return respond(200, {**summarise(items["JOB"], items.get("RESULT"), items.get("COST#TOTAL")),
                         "components": components})


def text_link(doc_id):
    if not DOC_ID.match(doc_id):
        raise ValueError("That is not a valid document ID.")
    if "Item" not in table.get_item(Key={"pk": doc_id, "sk": "RESULT"}):
        return respond(404, {"error": "No extracted text for this document."})
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": CURATED_BUCKET, "Key": f"text/{doc_id}.txt",
                "ResponseContentType": "text/plain; charset=utf-8"},
        ExpiresIn=120)
    return respond(200, {"url": url})
