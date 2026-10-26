"""Registry and repair tests with an isolated, atomic in-memory collection double."""
import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from threading import RLock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend.test_api_integration import main
from case_registry import repair_plan, unique_cases
from repair_case_registry import repair


class Collection:
    def __init__(self, rows=()):
        self.rows = {row["_id"]: copy.deepcopy(row) for row in rows}
        self.lock = RLock()
        self.index = None

    def find(self, query):
        with self.lock:
            return copy.deepcopy(list(self.rows.values()))

    def find_one(self, query):
        with self.lock:
            return copy.deepcopy(self.rows.get(query["_id"]))

    def replace_one(self, query, row, upsert=False):
        with self.lock:
            self.rows[query["_id"]] = copy.deepcopy(row)

    def update_one(self, query, update, upsert=False):
        with self.lock:
            key = query["_id"]
            if key not in self.rows:
                if not upsert:
                    return
                self.rows[key] = {"_id": key, **copy.deepcopy(update.get("$setOnInsert", {}))}
            self.rows[key].update(copy.deepcopy(update.get("$set", {})))
            for field in update.get("$unset", {}):
                self.rows[key].pop(field, None)

    def delete_one(self, query):
        with self.lock:
            row = self.rows.get(query["_id"])
            matched = row is not None and all(row.get(k) == v for k, v in query.items())
            if matched:
                del self.rows[query["_id"]]
            return SimpleNamespace(deleted_count=int(matched))

    def create_index(self, field, **kwargs):
        self.index = (field, kwargs)


class RegistryTests(unittest.TestCase):
    def test_concurrent_saves_keep_one_record_per_id(self):
        db = SimpleNamespace(cases=Collection())
        store = main.MongoStorage(db)
        rows = [{"case_id": str(i), "status": "open"} for i in range(326)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: store.save_cases(rows), range(4)))
        self.assertEqual(len(db.cases.rows), 326)
        self.assertTrue(all(row["_id"] == row["case_id"] for row in db.cases.find({})))

    def test_narrow_updates_preserve_other_cases_and_completion(self):
        db = SimpleNamespace(cases=Collection([
            {"_id": "old-a", "case_id": "a", "status": "completed", "completed_by": "owner"},
            {"_id": "b", "case_id": "b", "status": "open"},
        ]))
        store = main.MongoStorage(db)
        store.update_case("a", {"title": "New title"}, create=True)
        self.assertEqual(db.cases.rows["a"]["completed_by"], "owner")
        self.assertEqual(db.cases.rows["b"]["status"], "open")
        store.update_case("a", {"status": "open"}, unset=("completed_by",))
        self.assertNotIn("completed_by", db.cases.rows["a"])
        self.assertEqual(store.read_cases()[0]["status"], "open")
        self.assertFalse(store.update_case("missing", {"status": "open"}))

    def test_legacy_read_preserves_completion_without_deleting_copies(self):
        rows = [{"_id": "old-1", "case_id": "a", "status": "open"},
                {"_id": "old-2", "case_id": "a", "status": "completed"}]
        self.assertEqual(unique_cases(rows), [{"case_id": "a", "status": "completed"}])
        self.assertEqual(len(rows), 2)
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            repair_plan(rows)

    def test_repair_dry_run_backup_and_idempotence(self):
        from bson import ObjectId
        rows = [{"_id": ObjectId(), "case_id": "a", "status": "open"} for _ in range(4)]
        db = SimpleNamespace(name="isolated_test", cases=Collection(rows))
        with tempfile.TemporaryDirectory() as directory:
            repair(db, directory)
            self.assertEqual(len(db.cases.rows), 4)
            self.assertEqual(list(Path(directory).iterdir()), [])
            with self.assertRaises(ValueError):
                repair(db, directory, apply=True)
            repair(db, directory, apply=True, maintenance_confirmed=True)
            self.assertEqual(list(db.cases.rows), ["a"])
            from bson import json_util
            backup = json_util.loads(next(Path(directory).glob("*.json")).read_text())
            self.assertEqual(backup["rows"], rows)
            self.assertTrue(db.cases.index[1]["unique"])
            repair(db, directory, apply=True, maintenance_confirmed=True)
            self.assertEqual(list(db.cases.rows), ["a"])

    def test_repair_stops_when_backup_fails(self):
        db = SimpleNamespace(name="isolated_test", cases=Collection([
            {"_id": "legacy", "case_id": "a", "status": "open"}]))
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "open", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                repair(db, directory, apply=True, maintenance_confirmed=True)
        self.assertEqual(list(db.cases.rows), ["legacy"])

    def test_conflicts_and_id_collisions_stop_before_writes(self):
        for rows in ([{"_id": "x", "case_id": "a", "status": "open"},
                      {"_id": "y", "case_id": "a", "status": "completed"}],
                     [{"_id": "a", "case_id": "b"}, {"_id": "x", "case_id": "a"}]):
            db = SimpleNamespace(name="isolated_test", cases=Collection(rows))
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    repair(db, directory, apply=True, maintenance_confirmed=True)
            self.assertEqual(db.cases.find({}), rows)


if __name__ == "__main__":
    unittest.main()
