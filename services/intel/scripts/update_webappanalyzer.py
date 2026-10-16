"""Vendors the webappanalyzer technology database (the open continuation of Wappalyzer's) at a pinned commit.

uv run python scripts/update_webappanalyzer.py <commit-sha>

Writes app/vendor/webappanalyzer/{categories.json, technologies/*.json, LICENSE, COMMIT}. The data is GPL-3.0
(see LICENSE there); it is read at run time by app/services/site_intel/extractors/tech.py and never modified.
Pick a commit at least two weeks old, review the diff of the JSON files, then commit them together with
COMMIT.
"""

import argparse
import json
import re
import string
import urllib.request
from pathlib import Path

REPO = "enthec/webappanalyzer"
OUT = Path(__file__).resolve().parents[1] / "app/vendor/webappanalyzer"
LETTERS = ["_", *string.ascii_lowercase]
FILES = ["src/categories.json", "LICENSE"] + [f"src/technologies/{c}.json" for c in LETTERS]


def fetch(commit: str, path: str) -> bytes:
    url = f"https://raw.githubusercontent.com/{REPO}/{commit}/{path}"
    with urllib.request.urlopen(url, timeout=30) as response:
        data: bytes = response.read()
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit", help="full commit sha of enthec/webappanalyzer")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("commit must be a full sha")
    (OUT / "technologies").mkdir(parents=True, exist_ok=True)
    for path in FILES:
        data = fetch(args.commit, path)
        target = OUT / path.removeprefix("src/")
        if target.suffix == ".json":
            # Re-serialised with sorted keys: stable diffs between updates.
            normalised = json.dumps(json.loads(data), indent=1, sort_keys=True, ensure_ascii=False)
            data = (normalised + "\n").encode()
        target.write_bytes(data)
    (OUT / "COMMIT").write_text(args.commit + "\n")
    print(f"vendored {REPO}@{args.commit} into {OUT}")


if __name__ == "__main__":
    main()
