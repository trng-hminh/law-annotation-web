import { actorIds, partyRole } from './parties.js';

export const SCHEMA_VERSION = 3;
const kinds = { request: ['requests', 'request_id', 'R'], opinion: ['opinions', 'opinion_id', 'O'], premise: ['premises', 'premise_id', 'PR'] };
const outcomeIn = { ACCEPTED: 'accepted', PARTIALLY_ACCEPTED: 'partial', PARTIAL: 'partial', REJECTED: 'rejected', DISCONTINUED: 'discontinued' };
const outcomeOut = { accepted: 'ACCEPTED', partial: 'PARTIALLY_ACCEPTED', rejected: 'REJECTED', discontinued: 'DISCONTINUED' };
const textOf = (x) => x.text ?? x.span?.text ?? '';
const ids = (xs) => [...new Set((xs || []).map(String))];
const requestStates = ['ACTIVE', 'WITHDRAWN', 'PARTIALLY_WITHDRAWN'];
export const normalizeOutcome = (value) => outcomeIn[String(value ?? '').trim().toUpperCase()] ?? null;

// Suggestions come only from the permission-filtered /doc response, never /source.
// Do not silently change existing drafts or attach a label to a reused Request ID.
export function sourceOutcomeSuggestion(source, request) {
  if (source?.type !== 'self' || request.outcome) return null;
  const original = source.units.find((u) => u.type === 'request' && u.id === request.id);
  if (!original || original.text !== request.text) return null;
  if (JSON.stringify([...actorIds(original)].sort()) !== JSON.stringify([...actorIds(request)].sort())) return null;
  return normalizeOutcome(original.outcome);
}

export function normalizeGraph(source, { sourceSuggestions = false } = {}) {
  if (!source || typeof source !== 'object' || (source.id == null && source.case_id == null)) throw new Error('Case thiếu id / case_id.');
  const doc = structuredClone(source);
  doc.id = String(doc.id ?? doc.case_id);
  doc.title ||= `Case ${doc.id}`;
  doc.parties = (doc.parties || []).map((p) => ({ ...p, id: String(p.id ?? p.party_id), role: partyRole(p).label }));
  const internal = Array.isArray(doc.units);
  const newSchema = doc.annotation_schema_version === 3 || 'opinions' in doc || 'premises' in doc;
  const raw = internal ? doc.units : [
    ...Object.entries(kinds).flatMap(([type, [group, idKey]]) => (doc[group] || []).map((u) => ({ ...u, id: String(u[idKey]), type }))),
    ...(doc.claims || []).map((u) => ({ ...u, id: String(u.claim_id), type: 'claim' })),
    ...(doc.legacy_units || []),
  ];
  doc.units = raw.map((u) => {
    const request = u.type === 'request';
    const outcomeRecord = (doc.request_outcomes || []).find((x) => String(x.request_id) === String(u.id));
    return { ...u, id: String(u.id), text: textOf(u), assertedBy: actorIds(u),
      status: internal && ['confirmed', 'unconfirmed'].includes(u.status) ? u.status : (u.annotation_status || 'unconfirmed'),
      ...(request ? {
        request_status: u.request_status || (requestStates.includes(u.status) ? u.status : 'ACTIVE'),
        modification_spans: u.modification_spans || [], premise_ids: ids(u.premise_ids), opinion_ids: ids(u.opinion_ids),
        outcome: sourceSuggestions ? normalizeOutcome(u.outcome) || normalizeOutcome(outcomeRecord?.outcome)
          : internal && Object.hasOwn(u, 'outcome') ? normalizeOutcome(u.outcome) : normalizeOutcome(u.outcome ?? outcomeRecord?.outcome),
        linkedReasoning: u.linkedReasoning ?? (doc.request_reasoning_links || []).filter((x) => String(x.request_id) === u.id).map((x) => String(x.reasoning_id)),
        linkedDecisions: u.linkedDecisions ?? (doc.request_decision_links || []).filter((x) => String(x.request_id) === u.id).map((x) => String(x.decision_id)),
        needs_classification: u.needs_classification ?? !newSchema,
      } : u.type === 'opinion' ? { premise_ids: ids(u.premise_ids) } : {}),
    };
  });
  doc.reasoning = (doc.reasoning || doc.reasonings || []).map((x) => ({ ...x, id: String(x.id ?? x.reasoning_id), text: textOf(x), status: ['confirmed', 'unconfirmed'].includes(x.status) ? x.status : (x.annotation_status || 'unconfirmed') }));
  doc.decisions = (doc.decisions || []).map((x) => ({ ...x, id: String(x.id ?? x.decision_id), text: textOf(x), status: ['confirmed', 'unconfirmed'].includes(x.status) ? x.status : (x.annotation_status || 'unconfirmed') }));
  doc.annotation_schema_version = 3;
  if (doc._editor_state?.tab === 'claims' || doc._editor_state?.tab === 'units') doc._editor_state.tab = 'requests';
  return doc;
}

function canonicalItem(u, idKey) {
  const item = { ...u, [idKey]: u.id, span: { ...u.span, text: u.text }, annotation_status: u.status };
  for (const key of ['id', 'type', 'text', 'assertedBy', 'requestedBy', 'requested_by', 'status', 'request_status', 'linkedReasoning', 'linkedDecisions', 'outcome']) delete item[key];
  item.section ||= idKey === 'reasoning_id' ? 'assessment' : idKey === 'decision_id' ? 'decision' : 'content';
  if (['request_id', 'opinion_id', 'premise_id'].includes(idKey)) item.asserted_by = actorIds(u);
  if (idKey === 'request_id') item.status = u.request_status || 'ACTIVE';
  else delete item.modification_spans;
  return item;
}

export function serializeGraph(doc) {
  const result = { ...doc, case_id: doc.id, annotation_schema_version: 3, annotation_editor_version: 2 };
  for (const key of ['units', 'claims', 'reasoning', 'requests', 'opinions', 'premises', 'legacy_units']) delete result[key];
  for (const [type, [group, idKey]] of Object.entries(kinds)) result[group] = doc.units.filter((u) => u.type === type).map((u) => canonicalItem(u, idKey));
  result.legacy_units = doc.units.filter((u) => u.type === 'claim');
  result.reasonings = doc.reasoning.map((u) => canonicalItem(u, 'reasoning_id'));
  result.decisions = doc.decisions.map((u) => canonicalItem(u, 'decision_id'));
  result.parties = doc.parties.map((p) => ({ ...p, party_id: p.id, procedural_role: partyRole(p).value }));
  for (const [field, selection, target] of [['request_reasoning_links', 'linkedReasoning', 'reasoning_id'], ['request_decision_links', 'linkedDecisions', 'decision_id']]) {
    result[field] = doc.units.filter((u) => u.type === 'request').flatMap((u) => (u[selection] || []).map((id) => ({
      ...(doc[field] || []).find((x) => String(x.request_id) === u.id && String(x[target]) === id), request_id: u.id, [target]: id,
    })));
  }
  result.request_outcomes = doc.units.filter((u) => u.type === 'request' && u.outcome).map((u) => ({
    ...(doc.request_outcomes || []).find((x) => String(x.request_id) === u.id), request_id: u.id, outcome: outcomeOut[u.outcome] || u.outcome,
  }));
  return result;
}

export function nextUnitId(doc, type) {
  const prefix = kinds[type]?.[2] || ({ reasoning: 'RE', decisions: 'DE' }[type]) || 'C';
  const used = new Set([...doc.units, ...doc.reasoning, ...doc.decisions].map((u) => u.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function attachUnit(doc, parentId, type, targetId, checked) {
  const key = type === 'opinion' ? 'opinion_ids' : 'premise_ids';
  return { ...doc, units: doc.units.map((u) => u.id !== parentId ? u : { ...u, status: 'unconfirmed',
    [key]: checked ? ids([...(u[key] || []), targetId]) : (u[key] || []).filter((id) => id !== targetId) }) };
}

export function addGraphUnit(doc, data, parentId = null) {
  const unit = { ...data, id: nextUnitId(doc, data.type), status: 'unconfirmed',
    ...(data.type === 'request' ? { request_status: data.request_status || 'ACTIVE', premise_ids: [], opinion_ids: [], linkedReasoning: [], linkedDecisions: [], linksConfirmed: false } : data.type === 'opinion' ? { premise_ids: [] } : {}) };
  const next = { ...doc, units: [...doc.units, unit] };
  return parentId ? attachUnit(next, parentId, data.type, unit.id, true) : next;
}

export function removeGraphUnit(doc, id) {
  return { ...withoutRequestMetadata(doc, id), units: doc.units.filter((u) => u.id !== id).map((u) => ({ ...u,
    ...(u.premise_ids?.includes(id) ? { premise_ids: u.premise_ids.filter((x) => x !== id), status: 'unconfirmed' } : {}),
    ...(u.opinion_ids?.includes(id) ? { opinion_ids: u.opinion_ids.filter((x) => x !== id), status: 'unconfirmed' } : {}),
  })) };
}

function withoutRequestMetadata(doc, id) {
  return { ...doc, ...Object.fromEntries(['request_reasoning_links', 'request_decision_links', 'request_outcomes']
    .map((key) => [key, (doc[key] || []).filter((x) => String(x.request_id) !== id)])) };
}

export function classifyUnit(doc, id, type) {
  const original = doc.units.find((u) => u.id === id);
  if (!original) return doc;
  const newId = type === original.type ? id : nextUnitId(doc, type);
  const archived = { ...original, request_reasoning_links: (doc.request_reasoning_links || []).filter((x) => String(x.request_id) === id),
    request_decision_links: (doc.request_decision_links || []).filter((x) => String(x.request_id) === id),
    request_outcomes: (doc.request_outcomes || []).filter((x) => String(x.request_id) === id) };
  const converted = { ...original, id: newId, type, status: 'unconfirmed', needs_classification: false, legacy_source: original.legacy_source || archived };
  if (type !== 'request') for (const key of ['request_id', 'claim_id', 'request_status', 'modification_spans', 'opinion_ids', 'outcome', 'linkedReasoning', 'linkedDecisions', 'linksConfirmed']) delete converted[key];
  if (type === 'opinion') converted.premise_ids ||= [];
  return { ...(original.type === 'request' && type !== 'request' ? withoutRequestMetadata(doc, id) : doc),
    units: doc.units.map((u) => u.id === id ? converted : u) };
}

export function graphError(doc) {
  if (doc.units.some((u) => u.type === 'claim' || u.needs_classification)) return 'Hãy phân loại Claims cũ và rà soát Requests cũ trước khi hoàn tất.';
  const all = [...doc.units, ...doc.reasoning, ...doc.decisions];
  if (new Set(all.map((u) => u.id)).size !== all.length) return 'ID annotation bị trùng. Hãy kiểm tra dữ liệu nhập.';
  const groups = { premise_ids: doc.units.filter((u) => u.type === 'premise'), opinion_ids: doc.units.filter((u) => u.type === 'opinion'), linkedReasoning: doc.reasoning, linkedDecisions: doc.decisions };
  for (const u of doc.units) {
    if (!u.text?.trim() || !actorIds(u).length) return `Mục ${u.id} thiếu nội dung hoặc người trình bày.`;
    for (const [key, targets] of Object.entries(groups)) if ((u[key] || []).some((id) => !targets.some((t) => t.id === id))) return `${u.id}: liên kết ${key} trỏ đến mục không tồn tại.`;
  }
  return '';
}

export function supportLabels(doc, id) {
  return doc.units.filter((u) => u.premise_ids?.includes(id)).map((u) => u.type === 'request' ? u.id :
    `${u.id} (thuộc ${doc.units.filter((r) => r.type === 'request' && r.opinion_ids?.includes(u.id)).map((r) => r.id).join(', ') || 'chưa gắn Request'})`);
}
