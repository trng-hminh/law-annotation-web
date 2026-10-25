import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "./draftStore.js";

const auth = { type: "annotator", id: "A1", token: "never-persist-this" };
const doc = (text) => ({ id: "case-1", units: [{ id: "C1", text }], reasoning: [], decisions: [] });
function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), map };
}

test("refresh/log-in recovery retains unsynced edits and form buffers only for their owner", () => {
  const local = storage();
  const first = createDraftStore({ storage: local, saveRemote: async () => ({}) });
  first.stage(auth, { ...doc("human edit"), legal_provisions: [{ content: "hidden" }], claims: [{ text: "source" }],
    _editor_state: { addingType: "request", form: { text: "unfinished input" } } });
  const refreshed = createDraftStore({ storage: local, saveRemote: async () => ({}) });
  assert.equal(refreshed.last(auth), "case-1");
  const restored = refreshed.read(auth, "case-1").payload;
  assert.equal(restored.units[0].text, "human edit");
  assert.equal(restored._editor_state.form.text, "unfinished input");
  assert.equal(restored.annotation_editor_version, 2);
  assert.equal(restored.legal_provisions, undefined);
  assert.equal(restored.claims, undefined);
  assert.equal(refreshed.read({ ...auth, id: "A2" }, "case-1"), null);
  assert.equal(refreshed.last({ ...auth, type: "admin" }), null);
  assert.ok(!JSON.stringify([...local.map.values()]).includes(auth.token));
});

test("an in-flight save is serialized and cannot erase or overwrite a newer edit", async () => {
  const local = storage();
  const writes = [];
  let completeFirst;
  const store = createDraftStore({ storage: local, saveRemote: async (_auth, payload) => {
    writes.push(payload.units[0].text);
    if (writes.length === 1) await new Promise((resolve) => { completeFirst = resolve; });
    return { saved_at: "server-time" };
  } });
  store.stage(auth, doc("first"));
  const saving = store.flush(auth, "case-1");
  await Promise.resolve();
  store.stage(auth, doc("latest"));
  assert.equal(store.flush(auth, "case-1"), saving);
  completeFirst();
  await saving;
  assert.deepEqual(writes, ["first", "latest"]);
  assert.equal(store.read(auth, "case-1"), null);
  await store.flush(auth, "case-1");
  assert.equal(writes.length, 2);
});

test("a failed save survives refresh and retries successfully", async () => {
  const local = storage();
  const store = createDraftStore({ storage: local, saveRemote: async () => { throw new Error("offline"); } });
  store.stage(auth, doc("offline edit"));
  await assert.rejects(store.flush(auth, "case-1"), /offline/);
  const recovered = createDraftStore({ storage: local, saveRemote: async (_auth, payload) => {
    assert.equal(payload.units[0].text, "offline edit");
    return { saved_at: "now" };
  } });
  await recovered.flush(auth, "case-1");
  assert.equal(recovered.read(auth, "case-1"), null);
});

test("unavailable browser storage still allows remote saving and reports the limitation", async () => {
  const statuses = [];
  const store = createDraftStore({ storage: { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } },
    onStatus: (_auth, _id, status) => statuses.push(status), saveRemote: async () => ({ saved_at: "now" }) });
  store.stage(auth, doc("edit"));
  await store.flush(auth, "case-1");
  assert.deepEqual(statuses, ["volatile", "saving", "saved"]);
});
