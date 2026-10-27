// Person IDs identify references; procedural roles are editable attributes.
export const PARTY_ROLES = [
  { value: "PLAINTIFF", label: "Nguyên đơn", style: "P" },
  { value: "DEFENDANT", label: "Bị đơn", style: "D" },
  { value: "RELATED_PARTY", label: "Đương sự liên quan", style: "R" },
  { value: "WITNESS", label: "Người làm chứng", style: "N" },
  { value: "REPRESENTATIVE", label: "Người đại diện", style: "N" },
  { value: "OTHER", label: "Người khác / chưa xác định", style: "N" },
];

export function partyRole(party) {
  const role = party?.role || party?.procedural_role || "OTHER";
  return PARTY_ROLES.find((item) => item.value === role || item.label === role)
    || { value: role, label: role, style: "N" };
}

export function actorIds(unit) {
  const value = unit?.assertedBy ?? unit?.requestedBy ?? unit?.asserted_by ?? unit?.requested_by ?? [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

export function partyUseCount(doc, id) {
  const saved = (doc.units || []).filter((unit) => actorIds(unit).includes(id)).length;
  return saved + (actorIds(doc._editor_state?.form).includes(id) ? 1 : 0);
}

export function editParty(doc, id, patch) {
  return { ...doc, parties: (doc.parties || []).map((party) => {
    if (party.id !== id) return party;
    const role = patch.role === undefined ? null : partyRole({ role: patch.role });
    return { ...party, ...patch, id: party.id,
      ...(role ? { role: role.label, procedural_role: role.value } : {}) };
  }) };
}

export function addParty(doc) {
  const used = new Set((doc.parties || []).map((party) => party.id));
  for (const unit of [...(doc.units || []), doc._editor_state?.form]) {
    for (const id of actorIds(unit)) used.add(id);
  }
  let index = 1;
  while (used.has(`person-${index}`)) index += 1;
  const id = `person-${index}`;
  return { ...doc, parties: [...(doc.parties || []), { id, party_id: id, name: "", role: PARTY_ROLES[5].label, procedural_role: "OTHER" }] };
}

export function removeParty(doc, id) {
  if (partyUseCount(doc, id)) return doc;
  return { ...doc, parties: (doc.parties || []).filter((party) => party.id !== id) };
}

export function partyValidation(doc) {
  const parties = doc.parties || [];
  if (parties.some((party) => !party.name?.trim())) return "Hãy nhập tên cho người mới trong phần Đương sự và người liên quan trước khi nộp bài.";
  const ids = new Set(parties.map((party) => party.id));
  if ((doc.units || []).some((unit) => actorIds(unit).some((id) => !ids.has(id)))) {
    return "Có annotation tham chiếu đương sự không còn trong danh sách. Hãy sửa asserted_by / requested_by trước khi nộp bài.";
  }
  return "";
}
