#!/usr/bin/env python3
"""Inspect MongoDB registry duplicates; --apply backs up and repairs identical copies.

Pause backend writes before applying. This script touches only the cases collection;
case_docs, case_pdfs, drafts, submissions, and assignments are not modified.
"""
import argparse
from datetime import datetime, timezone
import getpass
import os
from pathlib import Path

import certifi
from bson import json_util
from pymongo import MongoClient

from case_registry import repair_plan


def repair(db, backup_dir, *, apply=False, maintenance_confirmed=False):
    rows = list(db.cases.find({}))
    plan = repair_plan(rows)
    extra = len(rows) - len(plan)
    print(f"Database: {db.name}; registry rows: {len(rows)}; unique cases: {len(plan)}; duplicate rows: {extra}")
    if not apply:
        print("Inspection only. No data changed.")
        return
    if not maintenance_confirmed:
        raise ValueError("Pause backend writes first, then pass --maintenance-confirmed.")
    directory = Path(backup_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = directory / f"case-registry-before-repair-{stamp}.json"
    # Extended JSON preserves ObjectIds for recovery. Backup must finish before writes.
    with path.open("x", encoding="utf-8") as output:
        path.chmod(0o600)
        output.write(json_util.dumps({"database": db.name, "collection": "cases", "rows": rows}, indent=2))
        output.flush()
        os.fsync(output.fileno())
    print(f"Backup: {path.resolve()}")
    if list(db.cases.find({})) != rows:
        raise RuntimeError("Registry changed during inspection; nothing repaired. Pause writes and retry.")
    removed = 0
    for cid, doc, legacy in plan:
        # Never overwrite a record created/changed by another request.
        db.cases.update_one({"_id": cid}, {"$setOnInsert": doc}, upsert=True)
        canonical = db.cases.find_one({"_id": cid})
        if canonical != dict(doc, _id=cid):
            raise RuntimeError(f"Case {cid} changed during repair; stopped. Backup retained.")
        for original in legacy:
            # Match the full original record, not just its identity.
            result = db.cases.delete_one(original)
            if result.deleted_count != 1:
                raise RuntimeError(f"Case {cid} changed during repair; stopped. Backup retained.")
            removed += 1
    db.cases.create_index("case_id", unique=True, name="unique_case_id")
    final = list(db.cases.find({}))
    if len(final) != len(plan) or any(row.get("_id") != row.get("case_id") for row in final):
        raise RuntimeError("Verification failed; keep writes paused and inspect the backup.")
    print(f"Verified {len(final)} unique cases. Removed {removed} legacy registry rows after canonical copies were secured.")
    print("PDFs, source documents, drafts, submissions, and assignments were untouched.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--maintenance-confirmed", action="store_true")
    parser.add_argument("--backup-dir", default="backups")
    args = parser.parse_args()
    uri = os.environ.get("MONGODB_URI", "").strip() or getpass.getpass("MongoDB URI (hidden): ").strip()
    if not uri:
        parser.error("A MongoDB URI is required.")
    with MongoClient(uri, serverSelectionTimeoutMS=10000, tlsCAFile=certifi.where()) as client:
        # Match main.py's database selection exactly.
        try:
            db = client.get_default_database()
        except Exception:
            name = os.environ.get("MONGODB_DB", "").strip() or input("Database name [legal_annotation]: ").strip() or "legal_annotation"
            db = client[name]
        repair(db, args.backup_dir, apply=args.apply, maintenance_confirmed=args.maintenance_confirmed)


if __name__ == "__main__":
    main()
