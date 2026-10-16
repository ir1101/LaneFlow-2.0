"""Find the cheapest memory size for LaneFlow's functions with AWS Lambda Power Tuning.

For each (function, document) pair, the Power Tuning state machine invokes the function
repeatedly at every memory setting, discards the fastest and slowest 20% of runs (which
removes cold starts), and reports the average billed duration and cost per invocation.

Usage: python scripts/tune_memory.py
Needs the laneflow-tuning stack (tuning/template.yaml). Writes results/power_tuning.json.
"""
import json
import time
from pathlib import Path

import boto3

REGION = "ap-southeast-2"
ROOT = Path(__file__).resolve().parent.parent
TUNING_STACK = "laneflow-tuning"
RUNS_PER_SETTING = 10
SMALL = [128, 256, 512, 1024, 1769, 3008]
LARGE = [256, 512, 1024, 1769, 3008]  # 128 MB can run out of memory on large files

# (function, test file, memory settings). The extractor code is identical in all three
# lanes, so one function stands in for all of them.
PLAN = [
    ("laneflow-extract-baseline", "doc-001p.pdf", SMALL),
    ("laneflow-extract-baseline", "doc-008p.pdf", SMALL),
    ("laneflow-extract-baseline", "doc-025p.pdf", SMALL),
    ("laneflow-extract-baseline", "doc-080p.pdf", LARGE),
    ("laneflow-extract-baseline", "doc-300p.pdf", LARGE),
    ("laneflow-classifier", "doc-001p.pdf", [128, 256, 512]),
    ("laneflow-classifier", "doc-300p.pdf", [128, 256, 512]),
]

session = boto3.Session(region_name=REGION)
account = session.client("sts").get_caller_identity()["Account"]
bucket = f"laneflow-uploads-{account}-{REGION}"
s3 = session.client("s3")
sfn = session.client("stepfunctions")
lam = session.client("lambda")
outputs = session.client("cloudformation").describe_stacks(StackName=TUNING_STACK)["Stacks"][0]["Outputs"]
state_machine = next(o["OutputValue"] for o in outputs if o["OutputKey"] == "StateMachineARN")


def run(function, file, powers):
    path = ROOT / "test-data" / file
    key = f"tuning/{file}"
    s3.upload_file(str(path), bucket, key)  # the validator ignores the tuning/ prefix
    payload = {"docId": f"tuning-{function.split('-')[-1]}-{file[:-4]}", "bucket": bucket, "key": key,
               "mode": "adaptive" if function.endswith("classifier") else "baseline",
               "sizeBytes": path.stat().st_size}
    arn = lam.get_function_configuration(FunctionName=function)["FunctionArn"]
    execution = sfn.start_execution(stateMachineArn=state_machine, input=json.dumps({
        "lambdaARN": arn,
        "powerValues": powers,
        "num": RUNS_PER_SETTING,
        "payload": payload,
        "parallelInvocation": False,
        "strategy": "cost",
        "discardTopBottom": 0.2,
        "includeOutputResults": True,
    }))["executionArn"]
    while True:
        time.sleep(10)
        status = sfn.describe_execution(executionArn=execution)
        if status["status"] != "RUNNING":
            break
    if status["status"] != "SUCCEEDED":
        return {"function": function, "file": file, "error": status.get("error"), "cause": status.get("cause")}
    out = json.loads(status["output"])
    return {
        "function": function,
        "file": file,
        "pages": int(file[4:7]),
        "best": out.get("power"),
        "visualisation": out.get("stateMachine", {}).get("visualization"),
        "stats": [{"memoryMb": s["value"], "avgDurationMs": s["averageDuration"], "avgCostUsd": s["averagePrice"]}
                  for s in out.get("stats", [])],
    }


def main():
    original = {f: lam.get_function_configuration(FunctionName=f)["MemorySize"] for f, _, _ in PLAN}
    results = []
    for function, file, powers in PLAN:
        print(f"Tuning {function} on {file} at {powers} MB ...", flush=True)
        result = run(function, file, powers)
        results.append(result)
        if "error" in result:
            print(f"  failed: {result['error']} {result['cause'][:300] if result['cause'] else ''}")
            continue
        cheapest = min(s["avgCostUsd"] for s in result["stats"])
        for s in result["stats"]:
            print(f"  {s['memoryMb']:>5} MB  {s['avgDurationMs']:>9.1f} ms  ${s['avgCostUsd']:.9f}  "
                  f"{s['avgCostUsd'] / cheapest:>5.2f}x cheapest")
        print(f"  cheapest: {result['best']} MB  ({result['visualisation']})", flush=True)

    # Power Tuning publishes versions and moves $LATEST between settings; put each
    # function back exactly as the template defines it.
    for function, memory in original.items():
        if lam.get_function_configuration(FunctionName=function)["MemorySize"] != memory:
            lam.update_function_configuration(FunctionName=function, MemorySize=memory)
            print(f"Restored {function} to {memory} MB")

    target = ROOT / "results" / "power_tuning.json"
    target.write_text(json.dumps({"region": REGION, "runsPerSetting": RUNS_PER_SETTING,
                                  "discardTopBottom": 0.2, "results": results}, indent=2), encoding="utf-8")
    print(f"Wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
