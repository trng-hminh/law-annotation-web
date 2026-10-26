"""Case registry identity and legacy duplicate handling (no database side effects)."""


def unique_cases(rows):
    """Canonical ID records win; otherwise prefer completed legacy records.

    Legacy conflicts remain on disk for inspection by repair_case_registry.py.
    Reading never deletes data or changes saved assignments/annotations.
    """
    selected = {}
    priorities = {}
    for row in rows:
        cid = str(row["case_id"])
        priority = (row.get("_id") == cid, row.get("status") == "completed")
        if cid not in selected or priority > priorities[cid]:
            selected[cid] = {k: v for k, v in row.items() if k != "_id"}
            selected[cid]["case_id"] = cid
            priorities[cid] = priority
    return [selected[cid] for cid in sorted(selected)]


def repair_plan(rows):
    """Refuse conflicting copies; never guess which version to delete."""
    groups = {}
    for row in rows:
        cid = row.get("case_id")
        if not isinstance(cid, str) or not cid:
            raise ValueError("Registry contains an invalid case_id; manual inspection required.")
        groups.setdefault(cid, []).append(row)
    conflicts = []
    plan = []
    for cid, copies in groups.items():
        clean = [{k: v for k, v in row.items() if k != "_id"} for row in copies]
        if any(doc != clean[0] for doc in clean[1:]):
            conflicts.append(cid)
        # A canonical _id occupied by another case must never be overwritten.
        if any(row.get("_id") == cid and row.get("case_id") != cid for row in rows):
            conflicts.append(cid)
        plan.append((cid, clean[0], [row for row in copies if row["_id"] != cid]))
    if conflicts:
        raise ValueError("Conflicting registry records; nothing changed. Inspect case IDs: " + ", ".join(sorted(set(conflicts))))
    return plan
