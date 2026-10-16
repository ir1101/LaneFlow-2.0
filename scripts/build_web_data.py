"""Turn the measurements into web/data/results.json for the website.

Sources:
  results/final_per_document.csv     the current measured run (tuned lanes)
  results/v1_final_per_document.csv  the earlier run with the original lane sizes, if present
  results/power_tuning.json          AWS Lambda Power Tuning output, if present

The website's results section and its hero simulation read this file, so every figure on
the site is a measured median rather than a hand-copied number.

Usage: python scripts/build_web_data.py
"""
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
TARGET = ROOT / "web" / "data" / "results.json"


def load(path):
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    for r in rows:
        r["coldStart"] = r["coldStart"] == "True"
        for k in ("processingUsd", "productionTotalUsd", "standardTotalUsd", "extractBilledMs"):
            r[k] = float(r[k])
        r["pages"] = int(r["pages"])
        r["extractMemoryMb"] = int(r["extractMemoryMb"])
    return rows


def summarise(rows):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["file"], r["mode"])].append(r)

    def warm_median(file, mode, field):
        vals = [r[field] for r in groups[(file, mode)] if not r["coldStart"]]
        return statistics.median(vals) if vals else None

    files = []
    for file in sorted({r["file"] for r in rows}, key=lambda f: int(f[4:7])):
        adaptive = groups[(file, "adaptive")]
        entry = {"file": file, "pages": adaptive[0]["pages"],
                 "lane": statistics.mode(r["lane"] for r in adaptive)}
        for mode in ("adaptive", "baseline"):
            entry[mode] = {
                "processingUsd": warm_median(file, mode, "processingUsd"),
                "totalUsd": warm_median(file, mode, "productionTotalUsd"),
                "extractMs": warm_median(file, mode, "extractBilledMs"),
                "warmRuns": sum(not r["coldStart"] for r in groups[(file, mode)]),
            }
        files.append(entry)

    def saving(lane, field):
        chosen = [f for f in files if lane in (None, f["lane"])]
        if not chosen:
            return None
        a = sum(f["adaptive"][field] for f in chosen)
        b = sum(f["baseline"][field] for f in chosen)
        return 1 - a / b

    def orchestration(mode):
        warm = [r for r in rows if r["mode"] == mode and not r["coldStart"]]
        express = statistics.median(r["productionTotalUsd"] for r in warm)
        standard = statistics.median(r["standardTotalUsd"] for r in warm)
        return {"expressUsd": express, "standardUsd": standard, "ratio": standard / express}

    lanes = {}
    for lane in ("light", "heavy", "baseline"):
        mems = [r["extractMemoryMb"] for r in rows if r["lane"] == lane]
        if mems:
            lanes[lane] = statistics.mode(mems)

    return {
        "rounds": len({r["round"] for r in rows}),
        "documents": len(rows),
        "lanes": lanes,
        "files": files,
        "savings": {
            "all": {"processing": saving(None, "processingUsd"), "total": saving(None, "totalUsd")},
            "light": {"processing": saving("light", "processingUsd"), "total": saving("light", "totalUsd")},
            "heavy": {"processing": saving("heavy", "processingUsd"), "total": saving("heavy", "totalUsd")},
        },
        "orchestration": {"adaptive": orchestration("adaptive"), "baseline": orchestration("baseline")},
        "coldStarts": {mode: sum(r["coldStart"] for r in rows if r["mode"] == mode)
                       for mode in ("adaptive", "baseline")},
    }


def main():
    data = {"source": "results/final_per_document.csv", "region": "ap-southeast-2",
            **summarise(load(RESULTS / "final_per_document.csv"))}

    previous = RESULTS / "v1_final_per_document.csv"
    if previous.exists():
        v1 = summarise(load(previous))
        data["previous"] = {"lanes": v1["lanes"], "savings": v1["savings"]}

    tuning_file = RESULTS / "power_tuning.json"
    if tuning_file.exists():
        tuning = json.loads(tuning_file.read_text(encoding="utf-8"))
        data["tuning"] = [
            {"function": t["function"].replace("laneflow-", ""), "pages": t["pages"], "best": t["best"],
             "settings": [{"memoryMb": s["memoryMb"], "ms": round(s["avgDurationMs"], 1),
                           "usd": s["avgCostUsd"]} for s in t["stats"]]}
            for t in tuning["results"] if "stats" in t
        ]

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(data, indent=2), encoding="utf-8")
    s = data["savings"]
    fmt = lambda v: "n/a" if v is None else f"{v:.1%}"
    print(f"Wrote {TARGET.relative_to(ROOT)}: lanes {data['lanes']}; saving light {fmt(s['light']['processing'])}, "
          f"heavy {fmt(s['heavy']['processing'])}, all {fmt(s['all']['processing'])} processing / "
          f"{fmt(s['all']['total'])} total")


if __name__ == "__main__":
    main()
