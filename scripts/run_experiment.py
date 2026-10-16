"""Run the adaptive-against-baseline experiment from start to finish.

Uploads every test PDF in both modes for several rounds, waits until every document is
finished and its cost reconciled, then the results can be analysed with
    python scripts/analyse_costs.py <prefix>

Usage:
    python scripts/run_experiment.py --prefix w --rounds 1        warm-up (not analysed)
    python scripts/run_experiment.py --prefix n --rounds 5        the measured run
"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

import boto3

REGION = "ap-southeast-2"
ROOT = Path(__file__).resolve().parent.parent


def website_api():
    outputs = boto3.client("cloudformation", region_name=REGION).describe_stacks(
        StackName="laneflow")["Stacks"][0]["Outputs"]
    return next(o["OutputValue"] for o in outputs if o["OutputKey"] == "WebsiteUrl") + "/api"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, help="round label, for example n for n1, n2 ...")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--gap", type=int, default=45, help="seconds between rounds")
    args = parser.parse_args()

    account = boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]
    bucket = f"laneflow-uploads-{account}-{REGION}"
    s3 = boto3.client("s3", region_name=REGION)
    files = sorted((ROOT / "test-data").glob("doc-*.pdf"))
    expected = set()

    for r in range(1, args.rounds + 1):
        for path in files:
            for mode in ("adaptive", "baseline"):  # interleaved, so both modes see the same conditions
                name = f"{args.prefix}{r}-{path.name}"
                s3.upload_file(str(path), bucket, f"{mode}/{name}")
                expected.add((name, mode))
        print(f"round {args.prefix}{r} uploaded ({len(files) * 2} documents)", flush=True)
        if r < args.rounds:
            time.sleep(args.gap)

    # Wait until every document has finished and its billed cost has been reconciled.
    api = website_api()
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(15)
        docs = json.load(urllib.request.urlopen(f"{api}/documents?limit=100"))["documents"]
        done = {(d["file"], d["mode"]) for d in docs
                if d["status"] in ("COMPLETED", "FAILED") and d["costUsd"] is not None}
        missing = expected - done
        print(f"finished and costed: {len(expected) - len(missing)} of {len(expected)}", flush=True)
        if not missing:
            break
    else:
        print("Timed out waiting; some documents are still in progress.")


if __name__ == "__main__":
    main()
