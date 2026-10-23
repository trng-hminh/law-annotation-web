"""Normalize imported LLM cases while retaining source metadata and law text."""
from copy import deepcopy

ANNOTATION_FIELDS = ("units", "reasoning", "decisions", "legal_provisions")
RAW_ANNOTATION_FIELDS = ("claims", "requests", "reasonings", "request_outcomes",
                         "request_decision_links", "request_reasoning_links")
ANNOTATION_EDITOR_VERSION = 2


def validate_provisions(provisions):
    if not isinstance(provisions, list):
        raise ValueError("legal_provisions phải là một mảng.")
    for provision in provisions:
        if not isinstance(provision, dict) or any(
            key in provision and not isinstance(provision[key], str)
            for key in ("provision_id", "title", "content")
        ):
            raise ValueError("Nội dung legal_provisions không hợp lệ.")


def saved_annotation_view(source, saved):
    """Hide legacy source copies in expert work without modifying stored data.

    Older servers forcibly copied source provisions into every draft/submission.
    Exact source matches from that editor are not evidence of human authorship.
    Keep changed/new items and retain the original record on disk/in MongoDB.
    New editor records are never compared to the source: experts may legitimately
    annotate exactly the same passage as the model independently.
    """
    result = deepcopy(saved)
    result.setdefault("legal_provisions", [])
    if case_type(source.get("type")) != "expert" or saved.get("annotation_editor_version") == ANNOTATION_EDITOR_VERSION:
        return result
    original = normalize_case(source)

    def signature(field, item):
        if field == "legal_provisions":
            return (item.get("title", "").strip(), item.get("content", "").strip())
        text = item.get("text") or (item.get("span") or {}).get("text", "")
        if field == "units":
            actors = item.get("assertedBy") or item.get("asserted_by") or item.get("requested_by") or []
            if not isinstance(actors, list):
                actors = [actors]
            return (item.get("type"), text.strip(), tuple(sorted(map(str, actors))), item.get("outcome"))
        return text.strip()

    removed = False
    for field in ANNOTATION_FIELDS:
        suggestions = {signature(field, x) for x in original.get(field, [])}
        items = result.get(field) or []
        result[field] = [x for x in items if signature(field, x) not in suggestions]
        removed = removed or len(result[field]) != len(items)
    for field in RAW_ANNOTATION_FIELDS:
        if result.get(field):
            removed = True
        result[field] = []
    # Do not restore links pointing to source-only items that were just hidden.
    for unit in result["units"]:
        for link, target in (("linkedDecisions", "decisions"), ("linkedReasoning", "reasoning")):
            if link in unit:
                kept = {x.get("id") for x in result[target]}
                unit[link] = [iid for iid in unit[link] if iid in kept]
    if removed:
        result["legacy_suggestions_filtered"] = True
    return result


def case_type(value):
    return {"self": "self", "self_annotate": "self", "expert": "expert"}.get(value)


def normalize_case(source):
    doc = deepcopy(source)
    cid = str(doc.get("id") or doc.get("case_id") or "")
    doc["id"] = cid
    doc.setdefault("title", f"Case {cid}")
    if doc.get("type") is not None:
        mode = case_type(doc["type"])
        if mode is None:
            raise ValueError(f"Case {cid}: type phải là self, self_annotate hoặc expert.")
        doc["type"] = mode
    if "legal_provisions" in doc:
        validate_provisions(doc["legal_provisions"])
    # Already-normalized app cases (including existing installations).
    if isinstance(doc.get("units"), list):
        return doc
    if "case_id" not in source:
        return doc

    def text(item):
        return item.get("text") or (item.get("span") or {}).get("text", "")

    roles = {"PLAINTIFF": "Nguyên đơn", "DEFENDANT": "Bị đơn", "RELATED_PARTY": "Đương sự liên quan"}
    doc["parties"] = [dict(p, id=str(p.get("party_id", p.get("id", ""))),
                           role=roles.get(p.get("procedural_role"), p.get("role", "Đương sự")))
                      for p in doc.get("parties", [])]
    units = []
    for group, kind, id_key, actor in (("claims", "claim", "claim_id", "asserted_by"),
                                       ("requests", "request", "request_id", "requested_by")):
        for item in doc.get(group, []):
            iid = str(item.get(id_key, ""))
            actors = item.get(actor) or []
            unit = dict(item, id=iid, type=kind, text=text(item), status="unconfirmed",
                        assertedBy=[str(a) for a in actors] if isinstance(actors, list) else [str(actors)])
            if kind == "request":
                outcome = next((x.get("outcome") for x in doc.get("request_outcomes", [])
                                if str(x.get("request_id")) == iid), None)
                unit.update(outcome={"ACCEPTED": "accepted", "REJECTED": "rejected", "PARTIAL": "partial"}.get(str(outcome).upper()),
                            linkedDecisions=[str(x["decision_id"]) for x in doc.get("request_decision_links", []) if str(x.get("request_id")) == iid],
                            linkedReasoning=[str(x["reasoning_id"]) for x in doc.get("request_reasoning_links", []) if str(x.get("request_id")) == iid],
                            linksConfirmed=False)
            units.append(unit)
    doc["units"] = units
    doc["reasoning"] = [dict(x, id=str(x.get("reasoning_id", "")), text=text(x), status="unconfirmed") for x in doc.get("reasonings", [])]
    doc["decisions"] = [dict(x, id=str(x.get("decision_id", "")), text=text(x), status="unconfirmed") for x in doc.get("decisions", [])]
    return doc
