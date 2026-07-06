import json
import re
from pathlib import Path

DATASET = Path("data/results_20260702")
OUT = Path("manifest.json")

rows = []

for csv in DATASET.rglob("*.csv"):
    rel = csv.relative_to(DATASET).as_posix()
    parts = rel.split("/")

    info = {
        "path": f"data/results_20260702/{rel}",
        "country": parts[0],
        "interceptors": None,
        "salvo": None,
    }

    for p in parts:
        if p.startswith("int-"):
            info["interceptors"] = p.replace("int-", "")
        if p.startswith("sal-"):
            info["salvo"] = p.replace("sal-", "")

    rows.append(info)

rows.sort(key=lambda r: (r["country"], int(r["interceptors"]), int(r["salvo"])))

OUT.write_text(json.dumps(rows, indent=2))
print(f"Wrote {OUT} with {len(rows)} CSV files.")