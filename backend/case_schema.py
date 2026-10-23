"""Normalize imported LLM cases while retaining source metadata and law text."""
from copy import deepcopy


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
    if "legal_provisions" in doc and not isinstance(doc["legal_provisions"], list):
        raise ValueError(f"Case {cid}: legal_provisions phải là một mảng.")
    for provision in doc.get("legal_provisions", []):
        if not isinstance(provision, dict) or any(
            key in provision and not isinstance(provision[key], str)
            for key in ("provision_id", "title", "content")
        ):
            raise ValueError(f"Case {cid}: nội dung legal_provisions không hợp lệ.")
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
