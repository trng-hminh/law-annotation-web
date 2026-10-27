import { test } from "node:test";
import assert from "node:assert/strict";
import { partyRole, actorIds, editParty, addParty, removeParty, partyUseCount, partyValidation } from "./parties.js";
import { createDraftStore } from "./draftStore.js";

const caseDoc = () => ({ id: "case-1", parties: [
  { id: "P1", party_id: "P1", name: "Misclassified person", role: "Nguyên đơn", procedural_role: "PLAINTIFF" },
  { id: "D1", name: "Other person", role: "Bị đơn" },
], units: [
  { id: "C1", type: "claim", assertedBy: ["P1"], asserted_by: ["P1"], text: "Claim" },
  { id: "R1", type: "request", assertedBy: ["P1"], requested_by: ["P1"], text: "Request" },
], reasoning: [], decisions: [] });

test("correcting a name and side preserves every annotation reference", () => {
  const original = caseDoc();
  const updated = editParty(original, "P1", { name: "Corrected name", role: "DEFENDANT" });
  assert.equal(updated.parties[0].id, "P1");
  assert.equal(updated.parties[0].party_id, "P1");
  assert.equal(updated.parties[0].name, "Corrected name");
  assert.equal(updated.parties[0].procedural_role, "DEFENDANT");
  assert.equal(partyRole(updated.parties[0]).style, "D");
  assert.deepEqual(updated.units, original.units);
  assert.equal(original.parties[0].role, "Nguyên đơn");
  assert.equal(partyRole({ id: "D9", role: "Đương sự liên quan" }).style, "R");
  assert.equal(partyRole({ id: "P9", role: "Người làm chứng" }).style, "N");
  assert.equal(partyRole({ id: "D0", procedural_role: "PLAINTIFF" }).style, "P");
});

test("new people avoid IDs referenced by saved and unfinished annotations", () => {
  const original = caseDoc();
  original.units.push({ assertedBy: ["person-1"] });
  original._editor_state = { form: { requested_by: "person-2" } };
  const updated = addParty(original);
  assert.equal(updated.parties.at(-1).id, "person-3");
  assert.match(partyValidation(updated), /nhập tên/);
  assert.equal(actorIds(updated._editor_state.form)[0], "person-2");
});

test("removal is blocked for saved or unfinished references, allowed when unused", () => {
  const doc = caseDoc();
  assert.equal(partyUseCount(doc, "P1"), 2);
  assert.equal(removeParty(doc, "P1"), doc);
  doc._editor_state = { form: { assertedBy: ["D1"] } };
  assert.equal(removeParty(doc, "D1"), doc);
  const cleared = { ...doc, _editor_state: {} };
  assert.equal(removeParty(cleared, "D1").parties.length, 1);
  assert.equal(partyValidation(doc), "");
  assert.match(partyValidation({ ...doc, parties: [] }), /tham chiếu/);
});

test("party corrections and new people survive browser recovery and server sync", async () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  let doc = editParty(caseDoc(), "P1", { role: "RELATED_PARTY", name: "Corrected" });
  doc = addParty(doc);
  doc = editParty(doc, "person-1", { name: "Missing witness", role: "WITNESS" });
  doc._editor_state = { form: { assertedBy: ["person-1"], text: "Unfinished" } };
  const auth = { id: "A1", type: "annotator" };
  createDraftStore({ storage, saveRemote: async () => ({}) }).stage(auth, doc);
  let sent;
  const recovered = createDraftStore({ storage, saveRemote: async (_, payload) => { sent = payload; return { saved_at: "now" }; } });
  assert.deepEqual(recovered.read(auth, doc.id).payload.parties, doc.parties);
  await recovered.flush(auth, doc.id);
  assert.deepEqual(sent.parties, doc.parties);
  assert.deepEqual(sent._editor_state.form.assertedBy, ["person-1"]);
  assert.deepEqual(sent.units[0].assertedBy, ["P1"]);
});
