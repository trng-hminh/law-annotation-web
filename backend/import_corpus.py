#!/usr/bin/env python3
"""Validate a corpus offline, or back up and import it via the admin API.

No API calls or database changes without --apply. Passwords are prompted, or
read from ADMIN_PASSWORD. Source cases/settings are backed up before importing;
human drafts, assignments, and submissions are never deleted.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import re

import requests

from case_schema import normalize_case
from upload_pdfs import login


def load_corpus(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    raw = data if isinstance(data, list) else data.get("cases", [])
    if not isinstance(raw, list) or not raw:
        raise ValueError("Expected a non-empty case array or {cases: [...]}.")
    cases = [normalize_case(case) for case in raw]
    ids = [case["id"] for case in cases]
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", cid) for cid in ids):
        raise ValueError("All cases must have a valid non-empty case ID.")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate case IDs in corpus.")
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    parser.add_argument("--url", help="Deployed API base URL (required with --apply)")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--apply", action="store_true", help="Back up and import into the selected API")
    parser.add_argument("--backup-dir", default="backups")
    args = parser.parse_args()
    cases = load_corpus(args.file)
    print(f"Validated {len(cases)} cases: {dict(Counter(c.get('type', 'unspecified') for c in cases))}")
    print(f"Legal provisions: {sum(len(c.get('legal_provisions', [])) for c in cases)}")
    if not args.apply:
        print("Validation only. Add --url YOUR_API --apply to back up and import.")
        return
    if not args.url:
        parser.error("--url is required with --apply")
    base = args.url.rstrip("/")
    password = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Admin password: ")
    token = login(base, args.user, password)
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token}"

    def api(method, path, **kwargs):
        response = session.request(method, base + path, timeout=120, **kwargs)
        response.raise_for_status()
        return response.json()

    if api("GET", "/").get("corpus_schema_version", 0) < 3:
        raise RuntimeError("Deploy the updated backend before importing; no cases have been changed.")
    registry = api("GET", "/api/cases")
    settings = api("GET", "/api/annotation-settings")
    existing = {case["case_id"] for case in registry}
    backup_docs = [api("GET", f"/api/cases/{c['id']}/source") for c in cases if c["id"] in existing]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_dir = Path(args.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"corpus-before-{stamp}.json"
    with backup_path.open("x", encoding="utf-8") as out:
        json.dump({"api": base, "registry": registry, "settings": settings, "cases": backup_docs}, out, ensure_ascii=False, indent=2)
    backup_path.chmod(0o600)
    print(f"Backed up {len(backup_docs)} existing source cases and settings to {backup_path}")
    for start in range(0, len(cases), 10):
        batch = cases[start:start + 10]
        result = api("POST", "/api/cases", json={"cases": batch})
        if result.get("imported") != len(batch):
            raise RuntimeError(f"Incomplete batch at offset {start}; stop and inspect backup.")
        print(f"Imported {start + len(batch)}/{len(cases)}")

    overview = {c["case_id"]: c for c in api("GET", "/api/cases")}
    for case in cases:
        actual = api("GET", f"/api/cases/{case['id']}/source")
        if actual.get("legal_provisions", []) != case.get("legal_provisions", []):
            raise RuntimeError(f"Provision verification failed for {case['id']}")
        if case.get("type") and (actual.get("type") != case["type"] or
                                overview[case["id"]].get("show_suggestions") != (case["type"] == "self")):
            raise RuntimeError(f"Type/suggestions verification failed for {case['id']}; deploy the updated backend first.")
    print(f"Verified {len(cases)} source cases, provision details, and automatic suggestion settings.")


if __name__ == "__main__":
    main()
