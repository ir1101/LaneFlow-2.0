"""Compare adaptive routing against the over-provisioned baseline using measured figures.

For every document in the chosen measurement set (uploads named <prefix><round>-doc-NNNp.pdf):
  1. Lambda cost uses the exact Billed Duration from each invocation's REPORT log line,
     matched to the cost record by request ID.
  2. The Express execution is priced from its logged start and end times; its states
     are counted so the same run can also be priced as a Standard workflow.
  3. Costs are split into production cost (what the pipeline costs to run) and
     measurement overhead (the cost-record writes and Step Functions logs that exist
     only because we are measuring).
  4. Any document where an invocation paid a cold start (an Init Duration) is left out
     of the steady-state medians; cold starts are reported separately.

Usage: python scripts/analyse_costs.py [prefix]      (default prefix: m)
Writes results/final_per_document.csv and results/final_summary.md.
"""
import csv
import json
import math
import re
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import boto3

REGION = "ap-southeast-2"
TABLE = f"laneflow-documents-{REGION}"
LAMBDA_LOG_GROUPS = [f"/aws/lambda/laneflow-{n}" for n in
                     ("validator", "dispatcher", "classifier", "extract-light",
                      "extract-heavy", "extract-baseline")]
SFN_LOG_GROUP = "/aws/vendedlogs/states/laneflow-pipeline-express"

# Sydney on-demand prices from the AWS Price List API, 2026-10-16.
PRICE_GB_S = 0.0000133334          # Lambda arm64
PRICE_REQUEST = 0.0000002          # Lambda request
PRICE_DDB_WRITE = 0.00000071       # DynamoDB on-demand write request unit
PRICE_EXPRESS_REQUEST = 0.000001   # Step Functions Express, per execution
PRICE_EXPRESS_GB_S = 0.00001667    # Step Functions Express duration
EXPRESS_MEMORY_GB = 0.0625         # billed in 64 MB steps; small workflows use one step
PRICE_TRANSITION = 0.000025        # Step Functions Standard, for comparison only
PRICE_LOG_GB = 0.67                # CloudWatch Logs ingestion
PRICE_SQS_REQUEST = 0.0000004
PRICE_SNS_PUBLISH = 0.0000005

# States that call another AWS service directly (no Lambda), priced per call.
SERVICE_STATE_PRICES = {
    "MarkCompleted": PRICE_DDB_WRITE,
    "MarkFailed": PRICE_DDB_WRITE,
    "SendToDeadLetterQueue": PRICE_SQS_REQUEST,
    "NotifySuccess": PRICE_SNS_PUBLISH,
    "NotifyFailure": PRICE_SNS_PUBLISH,
}

PROCESSING = ("classifier", "extract-light", "extract-heavy", "extract-baseline")
OUT = Path(__file__).resolve().parent.parent / "results"
REPORT_RE = re.compile(r"RequestId: (\S+).*?Billed Duration: (\d+) ms"
                       r"(?:.*?Init Duration: ([\d.]+) ms)?")

session = boto3.Session(region_name=REGION)
ddb = session.client("dynamodb")
logs = session.client("logs")


def scan_table():
    items, kwargs = [], {"TableName": TABLE}
    while True:
        page = ddb.scan(**kwargs)
        items += page["Items"]
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def plain(item):
    out = {}
    for k, v in item.items():
        (t, val), = v.items()
        out[k] = float(val) if t == "N" else val
    return out


def log_events(group, pattern=None):
    """Yield every event in a log group from the last two days (no sampling)."""
    kwargs = {"logGroupName": group, "startTime": int((time.time() - 2 * 86400) * 1000)}
    if pattern:
        kwargs["filterPattern"] = pattern
    paginator = logs.get_paginator("filter_log_events")
    for page in paginator.paginate(**kwargs):
        yield from page["events"]


def billed_durations():
    """Return {requestId: (billedMs, initMs)} from Lambda REPORT lines."""
    found = {}
    for group in LAMBDA_LOG_GROUPS:
        for event in log_events(group, '"REPORT RequestId"'):
            m = REPORT_RE.search(event["message"])
            if m:
                found[m.group(1)] = (float(m.group(2)), float(m.group(3) or 0))
    return found


def express_executions():
    """Return {docId: {durationMs, states, logBytes}} from the Step Functions log.

    Executions are keyed by name, which the dispatcher sets to the document ID. An Express
    execution ARN looks like arn:aws:states:REGION:ACCOUNT:express:MACHINE:NAME:UUID.
    """
    runs = defaultdict(lambda: {"start": None, "end": None, "states": 0, "logBytes": 0,
                                "serviceUsd": 0.0})
    for event in log_events(SFN_LOG_GROUP):
        msg = json.loads(event["message"])
        run = runs[msg["execution_arn"]]
        run["logBytes"] += len(event["message"].encode("utf-8"))
        ts = int(msg["event_timestamp"])
        if msg["type"] == "ExecutionStarted":
            run["start"] = ts
        elif msg["type"] in ("ExecutionSucceeded", "ExecutionFailed", "ExecutionTimedOut"):
            run["end"] = ts
        elif msg["type"].endswith("StateEntered"):
            run["states"] += 1
            run["serviceUsd"] += SERVICE_STATE_PRICES.get(msg["details"].get("name"), 0.0)
    return {arn.split(":")[7]: {"durationMs": r["end"] - r["start"], "states": r["states"],
                                "logBytes": r["logBytes"], "serviceUsd": r["serviceUsd"]}
            for arn, r in runs.items() if r["start"] and r["end"]}


def build_rows(prefix):
    docs = defaultdict(lambda: {"costs": {}})
    for item in map(plain, scan_table()):
        d = docs[item["pk"]]
        if item["sk"] == "JOB":
            d["job"] = item
        elif item["sk"] == "RESULT":
            d["result"] = item
        elif item["sk"].startswith("COST#") and item["sk"] != "COST#TOTAL":  # TOTAL is the reconciler's sum
            d["costs"][item["component"]] = item

    billed = billed_durations()
    runs = express_executions()
    key_re = re.compile(rf"(adaptive|baseline)/({prefix}\d+)-(doc-(\d+)p\.pdf)$")
    rows, problems = [], []
    for doc_id, d in docs.items():
        job = d.get("job")
        m = key_re.match(job["key"]) if job else None
        if not m:
            continue
        label = job["key"]
        if "result" not in d:
            problems.append(f"{label}: no RESULT record (processing failed or unfinished)")
            continue
        if doc_id not in runs:
            problems.append(f"{label}: execution start or end not found in Step Functions log")
            continue

        row = {"docId": doc_id, "mode": m.group(1), "round": m.group(2), "file": m.group(3),
               "pages": int(m.group(4)), "lane": d["result"]["lane"]}
        processing = ingestion = telemetry = cold_penalty = 0.0
        cold_parts = []
        for comp, c in d["costs"].items():
            if c["requestId"] not in billed:
                problems.append(f"{label}: REPORT line missing for {comp}")
                break
            billed_ms, init_ms = billed[c["requestId"]]
            gb = c["memoryMb"] / 1024
            lambda_usd = gb * billed_ms / 1000 * PRICE_GB_S + PRICE_REQUEST
            ops_usd = c["storageOpsUsd"] - PRICE_DDB_WRITE  # minus the cost record itself
            telemetry += PRICE_DDB_WRITE
            if init_ms > 0:
                cold_parts.append(comp)
                cold_penalty += gb * init_ms / 1000 * PRICE_GB_S
            if comp in PROCESSING:
                processing += lambda_usd + ops_usd
            else:
                ingestion += lambda_usd + ops_usd
            if comp.startswith("extract"):
                row["extractMemoryMb"] = int(c["memoryMb"])
                row["extractBilledMs"] = billed_ms
        else:
            run = runs[doc_id]
            express_ms = math.ceil(run["durationMs"] / 100) * 100  # billed in 100 ms steps
            # Express charge plus the DynamoDB, SQS and SNS calls the state machine makes.
            orchestration = (PRICE_EXPRESS_REQUEST
                             + EXPRESS_MEMORY_GB * express_ms / 1000 * PRICE_EXPRESS_GB_S
                             + run["serviceUsd"])
            telemetry += run["logBytes"] / 1024 ** 3 * PRICE_LOG_GB
            production = processing + ingestion + orchestration
            row.update({
                "coldStart": bool(cold_parts),
                "coldComponents": "+".join(cold_parts),
                "coldPenaltyUsd": cold_penalty,
                "processingUsd": processing,
                "ingestionUsd": ingestion,
                "orchestrationUsd": orchestration,
                "productionTotalUsd": production,
                "measurementOverheadUsd": telemetry,
                "asMeasuredTotalUsd": production + telemetry,
                "statesEntered": run["states"],
                "standardTotalUsd": (processing + ingestion + run["states"] * PRICE_TRANSITION
                                     + run["serviceUsd"]),
            })
            rows.append(row)
    return rows, problems


def usd(x):
    return f"{x:.8f}"


def saving(a, b):
    return f"{1 - a / b:.1%}" if b else "n/a"


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else "m"
    rows, problems = build_rows(prefix)
    if not rows:
        print("No documents found for prefix", prefix)
        return
    rows.sort(key=lambda r: (r["pages"], r["mode"], r["round"]))
    OUT.mkdir(exist_ok=True)
    with open(OUT / "final_per_document.csv", "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    groups = defaultdict(list)
    for r in rows:
        groups[(r["file"], r["mode"])].append(r)
    files = sorted({r["file"] for r in rows})
    rounds = sorted({r["round"] for r in rows})

    def med(file, mode, field, warm_only=True):
        vals = [r[field] for r in groups[(file, mode)] if not (warm_only and r["coldStart"])]
        return statistics.median(vals) if vals else None

    lines = [
        "# LaneFlow cost comparison: final measurement",
        "",
        f"Region ap-southeast-2 (Sydney), Express workflow, rounds {', '.join(rounds)}, "
        f"{len(rows)} documents. All Lambda figures use AWS's own Billed Duration.",
        "",
        "- **Processing** = classifier + right-sized extractor (adaptive), or the 3008 MB "
        "extractor (baseline), including its S3 and DynamoDB requests.",
        "- **Production total** = processing + validator + dispatcher + Express execution.",
        "- Medians are taken over **warm runs only**; runs that paid a cold start are reported "
        "separately below. Measurement overhead is excluded from both and reported separately.",
        "",
        "## Steady-state cost per document (median of warm runs, USD)",
        "",
        "| File | Pages | Lane | Warm runs (A/B) | Adaptive processing | Baseline processing "
        "| Processing saving | Adaptive production total | Baseline production total | Total saving |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    sums = defaultdict(float)
    lane_sums = defaultdict(float)
    for f in files:
        a_rows, b_rows = groups[(f, "adaptive")], groups[(f, "baseline")]
        if not a_rows or not b_rows:
            continue
        ap, bp = med(f, "adaptive", "processingUsd"), med(f, "baseline", "processingUsd")
        at, bt = med(f, "adaptive", "productionTotalUsd"), med(f, "baseline", "productionTotalUsd")
        na = sum(not r["coldStart"] for r in a_rows)
        nb = sum(not r["coldStart"] for r in b_rows)
        lane = statistics.mode(r["lane"] for r in a_rows)
        if None in (ap, bp, at, bt):
            lines.append(f"| {f} | {a_rows[0]['pages']} | {lane} | {na}/{nb} | not enough warm runs |||||")
            continue
        for k, v in (("ap", ap), ("bp", bp), ("at", at), ("bt", bt)):
            sums[k] += v
            lane_sums[lane + k] += v
        lines.append(f"| {f} | {a_rows[0]['pages']} | {lane} | {na}/{nb} | {usd(ap)} | {usd(bp)} "
                     f"| {saving(ap, bp)} | {usd(at)} | {usd(bt)} | {saving(at, bt)} |")

    lines += [
        "",
        "Totals below add one document of each size (an even mix of the test set).",
        "",
        f"- **Processing:** adaptive {usd(sums['ap'])}, baseline {usd(sums['bp'])}, "
        f"saving **{saving(sums['ap'], sums['bp'])}**.",
        f"- **Production total:** adaptive {usd(sums['at'])}, baseline {usd(sums['bt'])}, "
        f"saving **{saving(sums['at'], sums['bt'])}**.",
        f"- Small files (light lane): processing saving "
        f"{saving(lane_sums['lightap'], lane_sums['lightbp'])}, total saving "
        f"{saving(lane_sums['lightat'], lane_sums['lightbt'])}.",
        f"- Large files (heavy lane): processing saving "
        f"{saving(lane_sums['heavyap'], lane_sums['heavybp'])}, total saving "
        f"{saving(lane_sums['heavyat'], lane_sums['heavybt'])}.",
        "",
        "## Run-to-run variability (processing cost, warm runs)",
        "",
        "| File | Adaptive min to max | Baseline min to max | Baseline extractor time, min to max (ms) |",
        "|---|---|---|---|",
    ]
    for f in files:
        a = [r["processingUsd"] for r in groups[(f, "adaptive")] if not r["coldStart"]]
        b = [r for r in groups[(f, "baseline")] if not r["coldStart"]]
        if a and b:
            bt_ms = [r["extractBilledMs"] for r in b]
            bp = [r["processingUsd"] for r in b]
            lines.append(f"| {f} | {usd(min(a))} to {usd(max(a))} | {usd(min(bp))} to {usd(max(bp))} "
                         f"| {min(bt_ms):.0f} to {max(bt_ms):.0f} |")

    lines += ["", "## Cold starts", ""]
    for mode in ("adaptive", "baseline"):
        cold = [r for r in rows if r["mode"] == mode and r["coldStart"]]
        total = sum(1 for r in rows if r["mode"] == mode)
        pen = statistics.median(r["coldPenaltyUsd"] for r in cold) if cold else 0
        lines.append(f"- {mode.capitalize()}: {len(cold)} of {total} documents hit at least one "
                     f"cold start; median extra cost per affected document {usd(pen)} USD.")
    lines += [
        "",
        "Adaptive mode spreads work across more functions (classifier plus two lanes), so at "
        "low or bursty volume it starts more fresh execution environments than the single "
        "baseline function.",
        "",
        "## Measurement overhead (median per document, USD)",
        "",
    ]
    for mode in ("adaptive", "baseline"):
        vals = [r["measurementOverheadUsd"] for r in rows if r["mode"] == mode]
        lines.append(f"- {mode.capitalize()}: {usd(statistics.median(vals))} (cost-record writes "
                     "plus Step Functions logs at level ALL). Not needed in production.")
    lines += ["", "## Orchestration choice: Express versus Standard (median per document, USD)", ""]
    for mode in ("adaptive", "baseline"):
        mode_rows = [r for r in rows if r["mode"] == mode and not r["coldStart"]]
        if mode_rows:
            e = statistics.median(r["productionTotalUsd"] for r in mode_rows)
            s = statistics.median(r["standardTotalUsd"] for r in mode_rows)
            lines.append(f"- {mode.capitalize()}: Express {usd(e)}, Standard {usd(s)} "
                         f"(Standard is {s / e:.1f} times dearer).")
    if problems:
        lines += ["", "## Data quality", ""] + [f"- {p}" for p in problems]
    else:
        lines += ["", "## Data quality", "", "- Every document matched its log records."]

    (OUT / "final_summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
