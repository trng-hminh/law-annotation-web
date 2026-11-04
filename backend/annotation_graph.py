"""Version 3 graph persistence. Relationships reference shared units, never copies."""
from copy import deepcopy

SCHEMA_VERSION = 3
GROUPS = {"request": ("requests", "request_id"), "opinion": ("opinions", "opinion_id"), "premise": ("premises", "premise_id")}
OUTCOMES = {"accepted": "ACCEPTED", "partial": "PARTIALLY_ACCEPTED", "rejected": "REJECTED", "discontinued": "DISCONTINUED"}
REQUEST_STATES = {"ACTIVE", "WITHDRAWN", "PARTIALLY_WITHDRAWN"}


def normalize_outcome(value):
    return {**{v: k for k, v in OUTCOMES.items()}, "PARTIAL": "partial"}.get(str(value or "").strip().upper())


def internal_graph(source):
    doc = deepcopy(source)
    if isinstance(doc.get("units"), list):
        return doc
    units = []
    for kind, (group, key) in GROUPS.items():
        for item in doc.get(group, []):
            uid = str(item.get(key, ""))
            actors = item.get("asserted_by", item.get("requested_by", []))
            u = dict(item, id=uid, type=kind, text=(item.get("span") or {}).get("text", item.get("text", "")),
                     assertedBy=actors if isinstance(actors, list) else [actors], status=item.get("annotation_status", "unconfirmed"))
            if kind == "request":
                outcome = next((x.get("outcome") for x in doc.get("request_outcomes", []) if str(x.get("request_id")) == uid), None)
                u.update(request_status=item.get("status", "ACTIVE"),
                         outcome=normalize_outcome(outcome),
                         linkedReasoning=[str(x["reasoning_id"]) for x in doc.get("request_reasoning_links", []) if str(x.get("request_id")) == uid],
                         linkedDecisions=[str(x["decision_id"]) for x in doc.get("request_decision_links", []) if str(x.get("request_id")) == uid])
            units.append(u)
    doc["units"] = units + doc.get("legacy_units", [])
    doc["reasoning"] = [dict(x, id=str(x.get("reasoning_id", "")), text=(x.get("span") or {}).get("text", x.get("text", "")), status=x.get("annotation_status", "unconfirmed")) for x in doc.get("reasonings", [])]
    doc["decisions"] = [dict(x, id=str(x.get("decision_id", "")), text=(x.get("span") or {}).get("text", x.get("text", "")), status=x.get("annotation_status", "unconfirmed")) for x in doc.get("decisions", [])]
    doc["id"] = str(doc.get("id", doc.get("case_id", "")))
    return doc


def canonical_graph(source):
    """Canonicalize internal records; keep legacy claims in an explicit review queue."""
    doc = internal_graph(source)
    result = deepcopy(doc)
    result.update(annotation_schema_version=SCHEMA_VERSION, case_id=str(doc.get("case_id", doc.get("id", ""))))
    for key in ("units", "reasoning", "claims", "_editor_state"):
        result.pop(key, None)

    def item(u, id_key):
        x = deepcopy(u)
        x.update({id_key: str(u["id"]), "span": {**(u.get("span") or {}), "text": u.get("text", "")}, "annotation_status": u.get("status", "unconfirmed")})
        x.setdefault("section", "assessment" if id_key == "reasoning_id" else "decision" if id_key == "decision_id" else "content")
        for key in ("id", "type", "text", "status", "assertedBy", "requestedBy", "requested_by", "request_status", "linkedReasoning", "linkedDecisions", "outcome"):
            x.pop(key, None)
        if id_key in {v[1] for v in GROUPS.values()}:
            x["asserted_by"] = u.get("assertedBy", u.get("asserted_by", u.get("requested_by", [])))
        if id_key == "request_id":
            x["status"] = u.get("request_status", "ACTIVE")
            x.setdefault("premise_ids", [])
            x.setdefault("opinion_ids", [])
            x.setdefault("modification_spans", [])
            x.setdefault("needs_classification", source.get("annotation_schema_version") != 3)
        else:
            x.pop("modification_spans", None)
        if id_key == "opinion_id":
            x.setdefault("premise_ids", [])
        return x

    for kind, (group, key) in GROUPS.items():
        result[group] = [item(u, key) for u in doc.get("units", []) if u.get("type") == kind]
    result["legacy_units"] = [u for u in doc.get("units", []) if u.get("type") == "claim"]
    result["reasonings"] = [item(u, "reasoning_id") for u in doc.get("reasoning", [])]
    result["decisions"] = [item(u, "decision_id") for u in doc.get("decisions", [])]
    for field, selection, target in (("request_reasoning_links", "linkedReasoning", "reasoning_id"), ("request_decision_links", "linkedDecisions", "decision_id")):
        old = {(str(x.get("request_id")), str(x.get(target))): x for x in doc.get(field, [])}
        result[field] = [{**old.get((u["id"], str(tid)), {}), "request_id": u["id"], target: str(tid)} for u in doc.get("units", []) if u.get("type") == "request" for tid in u.get(selection, [])]
    old_outcomes = {str(x.get("request_id")): x for x in doc.get("request_outcomes", [])}
    result["request_outcomes"] = [{**old_outcomes.get(u["id"], {}), "request_id": u["id"], "outcome": OUTCOMES.get(u["outcome"], u["outcome"])} for u in doc.get("units", []) if u.get("type") == "request" and u.get("outcome")]
    return result


def validate_graph(doc, complete=False):
    """Reject malformed/dangling graphs before persisting, while allowing draft review."""
    groups = {**{g: key for g, key in GROUPS.values()}, "reasonings": "reasoning_id", "decisions": "decision_id", "parties": "party_id"}
    registry = {}
    for group, key in groups.items():
        items = doc.get(group, [])
        if not isinstance(items, list) or any(not isinstance(x, dict) for x in items):
            raise ValueError(f"{group} phải là danh sách đối tượng.")
        values = [x.get(key, x.get("id")) for x in items]
        if any(not isinstance(x, str) or not x for x in values) or len(set(values)) != len(values):
            raise ValueError(f"{group}: ID rỗng hoặc trùng.")
        registry[group] = set(values)
    all_ids = [uid for group in groups if group != "parties" for uid in registry[group]]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("ID annotation phải duy nhất trong case.")
    for party in doc.get("parties", []):
        if not isinstance(party.get("name", ""), str):
            raise ValueError("Tên đương sự phải là chuỗi.")
    for group in ("reasonings", "decisions"):
        for item in doc.get(group, []):
            if not isinstance(item.get("span"), dict) or not isinstance(item["span"].get("text"), str):
                raise ValueError(f"{group}: thiếu span.text.")

    def references(item, key, target):
        refs = item.get(key, [])
        if not isinstance(refs, list) or any(not isinstance(x, str) for x in refs) or len(set(refs)) != len(refs) or any(x not in registry[target] for x in refs):
            raise ValueError(f"{key}: tham chiếu không hợp lệ hoặc bị trùng.")

    for group in ("requests", "opinions", "premises"):
        for u in doc.get(group, []):
            references(u, "asserted_by", "parties")
            span = u.get("span")
            if not isinstance(span, dict) or not isinstance(span.get("text"), str):
                raise ValueError(f"{group}: thiếu span.text.")
            if complete and (not span["text"].strip() or not u.get("asserted_by")):
                raise ValueError(f"{group}: thiếu nội dung hoặc người trình bày.")
            if group != "premises":
                references(u, "premise_ids", "premises")
            if group == "requests":
                references(u, "opinion_ids", "opinions")
                if u.get("status") not in REQUEST_STATES:
                    raise ValueError("Trạng thái Request không hợp lệ.")
                spans = u.get("modification_spans", [])
                if not isinstance(spans, list) or any(not isinstance(s, (dict, str)) for s in spans):
                    raise ValueError("modification_spans phải là danh sách đoạn trích.")
            elif "modification_spans" in u:
                raise ValueError("modification_spans chỉ thuộc Request.")
            if group != "requests" and "opinion_ids" in u:
                raise ValueError("opinion_ids chỉ thuộc Request.")
            if group == "premises" and "premise_ids" in u:
                raise ValueError("Premise không chứa premise_ids.")
    for field, target, id_key in (("request_reasoning_links", "reasonings", "reasoning_id"), ("request_decision_links", "decisions", "decision_id"), ("request_outcomes", None, None)):
        links = doc.get(field, [])
        if not isinstance(links, list) or any(not isinstance(x, dict) for x in links):
            raise ValueError(f"{field}: danh sách không hợp lệ.")
        seen = set()
        for link in links:
            pair = (link.get("request_id"), link.get(id_key) if id_key else None)
            if pair in seen or pair[0] not in registry["requests"] or (target and pair[1] not in registry[target]):
                raise ValueError(f"{field}: liên kết trùng hoặc không tồn tại.")
            seen.add(pair)
            if not target and link.get("outcome") not in OUTCOMES.values():
                raise ValueError("Outcome không hợp lệ.")
    if complete and (doc.get("legacy_units") or any(u.get("needs_classification") for u in doc.get("requests", []))):
        raise ValueError("Hãy phân loại Claims cũ và rà soát Requests cũ trước khi hoàn tất.")
    if complete and any(not str(p.get("name", "")).strip() for p in doc.get("parties", [])):
        raise ValueError("Tên đương sự không được để trống.")


def publication_copy(source):
    """Explicit downstream copy only: never used by save or annotation export."""
    result = canonical_graph(source)
    used = {pid for group in ("requests", "opinions") for item in result[group] for pid in item.get("premise_ids", [])}
    result["premises"] = [p for p in result["premises"] if p["premise_id"] in used]
    return result
