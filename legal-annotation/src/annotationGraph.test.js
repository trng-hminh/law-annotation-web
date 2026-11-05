import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGraph, serializeGraph, addGraphUnit, attachUnit, removeGraphUnit, classifyUnit, graphError, supportLabels, sourceOutcomeSuggestion } from './annotationGraph.js';
import { createDraftStore } from './draftStore.js';

const fixture = () => ({ case_id: '10455', annotation_schema_version: 3, notes: 'Ghi chú', parties: [{ party_id: 'P1', name: 'Person', procedural_role: 'PLAINTIFF' }],
  requests: [{ request_id: 'R1', span: { text: '  Original request\n', start: 7 }, asserted_by: ['P1'], status: 'PARTIALLY_WITHDRAWN', modification_spans: [{ text: 'Changed', start: 20 }], premise_ids: ['PR1'], opinion_ids: ['O1'] },
    { request_id: 'R2', span: { text: 'Second request' }, asserted_by: ['P1'], status: 'ACTIVE', premise_ids: ['PR1'], opinion_ids: ['O1'] }],
  opinions: [{ opinion_id: 'O1', span: { text: 'Opinion' }, asserted_by: ['P1'], premise_ids: ['PR1'] }],
  premises: [{ premise_id: 'PR1', span: { text: 'Premise' }, asserted_by: ['P1'] }, { premise_id: 'PR2', span: { text: 'Unlinked' }, asserted_by: ['P1'] }],
  reasonings: [{ reasoning_id: 'RE1', span: { text: 'Reason', start: 100 } }], decisions: [{ decision_id: 'DE1', span: { text: 'Decision' } }],
  request_reasoning_links: [{ request_id: 'R1', reasoning_id: 'RE1', vote_count: 3, vote_sources: ['a'] }],
  request_decision_links: [{ request_id: 'R1', decision_id: 'DE1', vote_count: 2 }],
  request_outcomes: [{ request_id: 'R1', outcome: 'DISCONTINUED', vote_agreement: 'yes', vote_detail: { a: 1 } }], legal_provisions: [{ content: 'law' }] });

test('canonical roundtrip preserves graph, full spans, lifecycle, votes, notes and unlinked premises', () => {
  const doc = normalizeGraph(fixture());
  assert.equal(graphError(doc), '');
  const saved = serializeGraph(doc);
  for (const key of ['request_reasoning_links', 'request_decision_links', 'request_outcomes', 'legal_provisions', 'notes']) assert.deepEqual(saved[key], fixture()[key]);
  assert.equal(saved.requests[0].status, 'PARTIALLY_WITHDRAWN');
  assert.equal(saved.requests[0].annotation_status, 'unconfirmed');
  assert.deepEqual(saved.requests[0].span, fixture().requests[0].span);
  assert.equal(saved.premises.length, 2);
  assert.equal(saved.units, undefined);
  assert.deepEqual(serializeGraph(normalizeGraph(saved)), saved);
});

test('shared units link by ID, removing links does not remove content, shared edits appear everywhere', () => {
  let doc = normalizeGraph(fixture());
  doc = attachUnit(doc, 'R1', 'premise', 'PR1', false);
  assert.equal(doc.units.filter((u) => u.type === 'premise').length, 2);
  assert.deepEqual(supportLabels(doc, 'PR1'), ['R2', 'O1 (thuộc R1, R2)']);
  doc = attachUnit(doc, 'R1', 'opinion', 'O1', true);
  assert.deepEqual(doc.units.find((u) => u.id === 'R1').opinion_ids, ['O1']);
  doc.units.find((u) => u.id === 'O1').text = 'Edited shared opinion';
  assert.equal(serializeGraph(doc).opinions.length, 1);
  doc = removeGraphUnit(doc, 'PR1');
  assert.deepEqual(doc.units.find((u) => u.id === 'O1').premise_ids, []);
  assert.equal(graphError(doc), '');
});

test('inline create adds exactly one shared unit and attaches atomically', () => {
  const doc = addGraphUnit(normalizeGraph(fixture()), { type: 'premise', text: 'New', assertedBy: ['P1'] }, 'O1');
  assert.equal(doc.units.filter((u) => u.type === 'premise').length, 3);
  assert.deepEqual(doc.units.find((u) => u.id === 'O1').premise_ids, ['PR1', 'PR3']);
});

test('legacy semantics require human review; converting a request retains old links for audit', () => {
  let doc = normalizeGraph({ id: 'legacy', units: [{ id: 'C1', type: 'claim', text: 'claim', assertedBy: ['P1'] }, { id: 'R1', type: 'request', text: 'response', assertedBy: ['P1'], linkedDecisions: ['DE1'], outcome: 'accepted', modification_spans: [{ text: 'old' }] }], reasoning: [], decisions: [{ id: 'DE1', text: 'decision' }], request_decision_links: [{ request_id: 1, decision_id: 'DE1', vote_count: 5 }] });
  assert.match(graphError(doc), /phân loại/);
  doc = classifyUnit(doc, 'C1', 'premise');
  doc = classifyUnit(doc, 'R1', 'opinion');
  const result = serializeGraph(doc);
  assert.equal(result.legacy_units.length, 0);
  assert.equal(result.requests.length, 0);
  assert.equal(result.request_outcomes.length, 0);
  assert.equal(result.opinions[0].modification_spans, undefined);
  assert.deepEqual(result.opinions[0].legacy_source.linkedDecisions, ['DE1']);
  assert.equal(result.premises[0].legacy_source.id, 'C1');
});

test('malformed graph references and duplicate IDs block completion', () => {
  const doc = normalizeGraph(fixture());
  doc.units[0].opinion_ids.push('missing');
  assert.match(graphError(doc), /không tồn tại/);
  doc.units.push({ ...doc.units[0] });
  assert.match(graphError(doc), /trùng/);
});

test('reusing a deleted or reclassified Request ID does not inherit old court votes', () => {
  for (const change of [(doc) => removeGraphUnit(doc, 'R1'), (doc) => classifyUnit(doc, 'R1', 'opinion')]) {
    let doc = change(normalizeGraph(fixture()));
    doc = addGraphUnit(doc, { type: 'request', assertedBy: ['P1'], text: 'New independent request' });
    const fresh = doc.units.find((u) => u.id === 'R1');
    fresh.linkedDecisions = ['DE1'];
    fresh.linkedReasoning = ['RE1'];
    fresh.outcome = 'accepted';
    const result = serializeGraph(doc);
    assert.deepEqual(result.request_decision_links, [{ request_id: 'R1', decision_id: 'DE1' }]);
    assert.deepEqual(result.request_outcomes, [{ request_id: 'R1', outcome: 'ACCEPTED' }]);
  }
});

test('canonical autosave restores unfinished inline creation, corrected parties and court metadata', async () => {
  const storage = new Map();
  const local = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  let sent;
  const options = { storage: local, saveRemote: async (_, value) => { sent = value; return { saved_at: 'now' }; } };
  const doc = normalizeGraph(fixture());
  doc.parties[0].name = 'Corrected';
  doc._editor_state = { tab: 'requests', picker: { parentId: 'O1', type: 'premise', creating: true, form: { text: 'Unfinished', assertedBy: ['P1'] } } };
  const auth = { type: 'admin', id: 'admin' };
  createDraftStore(options).stage(auth, doc);
  const fresh = createDraftStore(options);
  const restored = normalizeGraph(fresh.read(auth, doc.id).payload);
  assert.deepEqual(restored._editor_state, doc._editor_state);
  assert.equal(restored.parties[0].name, 'Corrected');
  await fresh.flush(auth, doc.id);
  assert.deepEqual(sent.request_decision_links, fixture().request_decision_links);
  assert.equal(sent.units, undefined);
});

test('source imports recognize every outcome, uppercase inline labels and numeric request IDs', () => {
  const values = ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'DISCONTINUED'];
  const source = { id: 'self', type: 'self', units: values.map((_, id) => ({ id, type: 'request', text: `Request ${id}`, assertedBy: ['P1'], outcome: null })),
    request_outcomes: values.map((outcome, request_id) => ({ request_id, outcome })) };
  const repaired = normalizeGraph(source, { sourceSuggestions: true });
  assert.deepEqual(repaired.units.map((u) => u.outcome), ['accepted', 'partial', 'rejected', 'discontinued']);
  assert.deepEqual(serializeGraph(repaired).request_outcomes.map((x) => x.outcome), values);
  source.units[0].outcome = 'ACCEPTED';
  assert.equal(normalizeGraph(source).units[0].outcome, 'accepted');
});

test('saved blank outcomes stay blank; source recovery is opt-in, Self-only and matched to the request', () => {
  const source = normalizeGraph({ ...fixture(), type: 'self' });
  const draft = structuredClone(source);
  draft.units[0].outcome = null;
  assert.equal(normalizeGraph(draft).units[0].outcome, null);
  assert.equal(sourceOutcomeSuggestion(source, draft.units[0]), 'discontinued');
  assert.equal(sourceOutcomeSuggestion({ ...source, type: 'expert' }, draft.units[0]), null);
  assert.equal(sourceOutcomeSuggestion({ ...source, units: [] }, draft.units[0]), null);
  assert.equal(sourceOutcomeSuggestion(source, { ...draft.units[0], text: 'New Request, reused ID' }), null);
  assert.equal(sourceOutcomeSuggestion(source, { ...draft.units[0], assertedBy: ['other'] }), null);
  assert.equal(sourceOutcomeSuggestion(source, { ...draft.units[0], outcome: 'accepted' }), null);
});
