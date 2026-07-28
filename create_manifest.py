import json
from pathlib import Path

DATA_ROOT = Path("data")
OUT = Path("manifest.json")

result_dirs = sorted(
    [
        d for d in DATA_ROOT.iterdir()
        if d.is_dir()
        and d.name.startswith("results_")
    ]
)

if len(result_dirs) != 1:
    raise RuntimeError(
        f"Expected exactly one active results directory in {DATA_ROOT}, "
        f"found {[d.name for d in result_dirs]}"
    )

DATASET = result_dirs[0]

rows = []

for csv in DATASET.rglob("*.csv"):
    rel = csv.relative_to(DATASET).as_posix()
    parts = rel.split("/")

    info = {
        "path": f"{DATASET.as_posix()}/{rel}",
        "country": parts[0],
        "interceptors": None,
        "salvo": None,
    }

    for p in parts:
        if p.startswith("int-"):
            info["interceptors"] = p.replace("int-", "")
        elif p.startswith("sal-"):
            info["salvo"] = p.replace("sal-", "")

    rows.append(info)

rows.sort(
    key=lambda r: (
        r["country"],
        int(r["interceptors"]),
        int(r["salvo"])
    )
)

OUT.write_text(json.dumps(rows, indent=2))
print(f"Wrote {OUT} with {len(rows)} CSV files from {DATASET.name}.")