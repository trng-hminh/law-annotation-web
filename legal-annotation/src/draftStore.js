// Pending browser backups are scoped to an account and case. Only annotation
// data is kept here: no auth tokens, source-only suggestions, or law metadata.
export function createDraftStore({ storage, saveRemote, onStatus = () => {}, now = () => new Date().toISOString() }) {
  const records = new Map();
  const flights = new Map();
  let revision = 0;
  const owner = (auth) => `${auth.type}:${encodeURIComponent(auth.id)}`;
  const key = (auth, id) => `legal-annotation-draft:v1:${owner(auth)}:${encodeURIComponent(id)}`;
  const lastKey = (auth) => `legal-annotation-last-case:${owner(auth)}`;
  const remove = (auth, id) => {
    const k = key(auth, id);
    // Avoid retrying an acknowledged record if browser storage cannot clear it.
    records.set(k, null);
    try { storage.removeItem(k); } catch { /* remote save remains authoritative */ }
  };
  const read = (auth, id) => {
    const k = key(auth, id);
    if (records.has(k)) return records.get(k);
    try {
      const record = JSON.parse(storage.getItem(k) || "null");
      if (record?.payload?.id === id && typeof record.revision === "string") {
        records.set(k, record);
        return record;
      }
    } catch { /* unavailable or malformed local storage */ }
    return null;
  };
  const remember = (auth, id) => {
    try { storage.setItem(lastKey(auth), id); } catch { /* resume is optional */ }
  };
  return {
    read,
    remember,
    last(auth) {
      try { return storage.getItem(lastKey(auth)); } catch { return null; }
    },
    forget(auth) {
      try { storage.removeItem(lastKey(auth)); } catch { /* optional */ }
    },
    clear: remove,
    stage(auth, doc) {
      const payload = Object.fromEntries(["id", "title", "type", "parties", "units", "reasoning", "decisions", "notes", "_editor_state"]
        .filter((field) => doc[field] !== undefined).map((field) => [field, doc[field]]));
      payload.annotation_editor_version = 2;
      const updatedAt = now();
      const record = { revision: `${updatedAt}:${++revision}`, updatedAt, durable: true, payload: JSON.parse(JSON.stringify(payload)) };
      records.set(key(auth, doc.id), record);
      remember(auth, doc.id);
      let durable = true;
      try { storage.setItem(key(auth, doc.id), JSON.stringify(record)); } catch { durable = false; record.durable = false; }
      onStatus(auth, doc.id, durable ? "local" : "volatile", updatedAt);
      return record;
    },
    flush(auth, id) {
      const k = key(auth, id);
      if (flights.has(k)) return flights.get(k);
      const task = Promise.resolve().then(async () => {
        try {
          let record = read(auth, id);
          while (record) {
            onStatus(auth, id, "saving");
            let result;
            try {
              result = await saveRemote(auth, record.payload);
            } catch (error) {
              onStatus(auth, id, record.durable === false ? "volatile" : "error");
              throw error;
            }
            // A completed older request must never clear a newer browser backup.
            if (read(auth, id)?.revision === record.revision) remove(auth, id);
            record = read(auth, id);
            onStatus(auth, id, record ? (record.durable === false ? "volatile" : "local") : "saved", result.saved_at);
          }
        } finally {
          flights.delete(k);
        }
      });
      flights.set(k, task);
      return task;
    },
  };
}
