"""Turn the final measurement (results/final_per_document.csv) into web/data/results.json.

The website's results section and its hero simulation both read this file, so the
figures on the site are exactly the measured medians, not hand-copied numbers.

Usage: python scripts/build_web_data.py
"""
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "results" / "final_per_document.csv"
TARGET = ROOT / "web" / "data" / "results.json"


def main():
    rows = list(csv.DictReader(open(SOURCE, encoding="utf-8")))
    for r in rows:
        r["coldStart"] = r["coldStart"] == "True"
        for k in ("processingUsd", "productionTotalUsd", "standardTotalUsd", "extractBilledMs"):
            r[k] = float(r[k])
        r["pages"] = int(r["pages"])

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
        a = sum(f["adaptive"][field] for f in chosen)
        b = sum(f["baseline"][field] for f in chosen)
        return 1 - a / b

    def orchestration(mode):
        warm = [r for r in rows if r["mode"] == mode and not r["coldStart"]]
        express = statistics.median(r["productionTotalUsd"] for r in warm)
        standard = statistics.median(r["standardTotalUsd"] for r in warm)
        return {"expressUsd": express, "standardUsd": standard, "ratio": standard / express}

    data = {
        "source": "results/final_per_document.csv",
        "region": "ap-southeast-2",
        "rounds": len({r["round"] for r in rows}),
        "documents": len(rows),
        "files": files,
        "savings": {
            "all": {"processing": saving(None, "processingUsd"), "total": saving(None, "totalUsd")},
            "light": {"processing": saving("light", "processingUsd"),
                      "total": saving("light", "totalUsd")},
            "heavy": {"processing": saving("heavy", "processingUsd"),
                      "total": saving("heavy", "totalUsd")},
        },
        "orchestration": {"adaptive": orchestration("adaptive"),
                          "baseline": orchestration("baseline")},
        "coldStarts": {mode: sum(r["coldStart"] for r in rows if r["mode"] == mode)
                       for mode in ("adaptive", "baseline")},
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(data, indent=2), encoding="utf-8")
    s = data["savings"]
    print(f"Wrote {TARGET.relative_to(ROOT)}: {len(files)} sizes; saving light "
          f"{s['light']['processing']:.1%}, heavy {s['heavy']['processing']:.1%}, "
          f"all {s['all']['processing']:.1%} processing / {s['all']['total']:.1%} total")


if __name__ == "__main__":
    main()
