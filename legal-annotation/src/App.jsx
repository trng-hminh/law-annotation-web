import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";
import rawPrototypeCases from "./prototype_10_cases.json";
import {
  ChevronLeft, ChevronRight, Plus, Pencil, Trash2, Link2,
  ZoomIn, ZoomOut, X, GripVertical, ScrollText, Gavel, ListChecks,
  Scale, CircleCheck, Circle, UserRound, LogOut,
  FolderOpen, Shield, Loader2, LayoutDashboard, RefreshCw,
  Users, Download, ClipboardList, Activity, CircleHelp, BookOpen,
  GraduationCap, Lightbulb
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

/* ----------------------------------------------------------------------
   DESIGN TOKENS
   Ink/paper palette borrowed from Vietnamese case-file registers: a deep
   ink-teal for structure, warm paper for the reading surface, and two
   adversarial hues (teal = nguyên đơn / cool, rust = bị đơn / warm) that
   never get reused for anything else in the UI, so color always means
   "which party" and nothing more.
------------------------------------------------------------------------- */
const T = {
  ink: "#1C2624",
  inkSoft: "#4A5551",
  paper: "#FAF7F0",
  paperDim: "#F1ECDF",
  paperCard: "#FFFFFF",
  line: "#E1D9C6",
  lineStrong: "#CDC2A6",
  gold: "#B8862E",
  goldTint: "#F4E9D2",
  danger: "#A23B2E",
};

const PARTY_STYLE = {
  P: { base: "#276767", deep: "#153F3F", tint: "#E4F0EC" },
  D: { base: "#B0552B", deep: "#7E3A1B", tint: "#FBECE0" },
};
const sideOf = (id) => (id?.[0] === "P" ? "P" : "D");

const OUTCOME_LABEL = {
  accepted: "Chấp nhận",
  rejected: "Không chấp nhận",
  partial: "Chấp nhận một phần",
};

/* ------------- sequential ordering (reasoning / decisions) -------------
   Immutable helpers: mỗi hàm trả về mảng mới (an toàn cho React state).
   - insertAtOrder: chèn item tại order n, đẩy mọi entry có order >= n lên +1.
   - deleteAtOrder: xoá theo id, rồi giảm order của các entry phía sau đi 1
     để lấp khoảng trống (giữ dãy liên tục 1..N như linked list). */

function insertAtOrder(list, item, n = item.order) {
  return [
    ...list.map((e) => (e.order >= n ? { ...e, order: e.order + 1 } : e)),
    { ...item, order: n },
  ];
}

function deleteAtOrder(list, id) {
  const target = list.find((e) => e.id === id);
  if (!target) return list;
  const n = target.order;
  return list
    .filter((e) => e.id !== id)
    .map((e) => (e.order > n ? { ...e, order: e.order - 1 } : e));
}

const nextOrder = (list) => (list.length ? Math.max(...list.map((e) => e.order || 0)) : 0) + 1;

/* ---------------------------- small pieces ---------------------------- */

function PartyTag({ id, parties, size = "sm" }) {
  const p = parties.find((x) => x.id === id);
  if (!p) return null;
  const style = PARTY_STYLE[sideOf(id)];
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: size === "sm" ? "2px 8px" : "3px 10px",
        borderRadius: 20, background: style.tint, color: style.deep,
        fontSize: size === "sm" ? 11.5 : 12.5, fontWeight: 600,
        border: `1px solid ${style.base}33`, whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: style.base }} />
      {p.name} <span style={{ opacity: 0.75, fontWeight: 500 }}>· {p.role}</span>
    </span>
  );
}

function IconBtn({ onClick, title, children, tone = "default", size = 28 }) {
  const colors = {
    default: { fg: T.inkSoft, hover: T.paperDim },
    danger: { fg: T.danger, hover: "#F6E4E0" },
    gold: { fg: T.gold, hover: T.goldTint },
  }[tone];
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: size, height: size, display: "inline-flex", alignItems: "center",
        justifyContent: "center", border: "none", borderRadius: 6, cursor: "pointer",
        background: hover ? colors.hover : "transparent", color: colors.fg,
        transition: "background 120ms ease",
      }}
    >
      {children}
    </button>
  );
}

function ConfirmToggle({ status, onClick }) {
  const confirmed = status === "confirmed";
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 11px", borderRadius: 20, cursor: "pointer",
        border: `1px solid ${confirmed ? "#5C8A63" : T.lineStrong}`,
        background: confirmed ? "#E9F2E7" : T.paperCard,
        color: confirmed ? "#3D6944" : T.inkSoft,
        fontSize: 12, fontWeight: 600, transition: "all 120ms ease",
      }}
    >
      {confirmed ? <CircleCheck size={14} /> : <Circle size={14} />}
      {confirmed ? "Đã xác nhận" : "Xác nhận"}
    </button>
  );
}

function ModificationList({ unit, onAdd, onUpdate, onRemove, onClose }) {
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState("content");

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const orders = (unit.modification_spans || []).map((m) => Number(m.order) || 0);
    const maxOrder = Math.max(Number(unit.order) || 0, ...orders, 0);
    onAdd({ order: maxOrder + 1, section, text });
    setDraft("");
  };

  return (
    <div style={{ marginTop: 10, padding: 12, background: T.paperDim, borderRadius: 8, border: `1px solid ${T.line}` }}>
      <p style={{ margin: "0 0 8px", fontSize: 11.5, color: T.inkSoft, fontWeight: 600 }}>
        modification_spans là các yêu cầu sửa đổi/bổ sung phát sinh trong quá trình tố tụng,
        mỗi mục có <code>order</code>, <code>section</code> và <code>text</code>.
      </p>

      {(unit.modification_spans || []).length === 0 ? (
        <div style={{ fontSize: 12, color: T.inkSoft, padding: "6px 0 10px" }}>Chưa có yêu cầu sửa đổi/bổ sung.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {[...(unit.modification_spans || [])].sort((a, b) => (a.order || 0) - (b.order || 0)).map((m, i) => (
            <div key={`${m.order}-${i}`} style={{
              background: T.paperCard, padding: "8px 10px", borderRadius: 7,
              border: `1px solid ${T.line}`, display: "flex", gap: 8, alignItems: "flex-start"
            }}>
              <div style={{
                minWidth: 28, height: 28, borderRadius: 6, background: T.goldTint, color: T.gold,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700
              }}>{m.order}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: T.inkSoft, textTransform: "uppercase" }}>
                    {m.section || "content"}
                  </span>
                </div>
                <textarea
                  value={m.text || ""}
                  onChange={(e) => onUpdate(m, { ...m, text: e.target.value })}
                  style={{ width: "100%", minHeight: 55, resize: "vertical", border: `1px solid ${T.line}`, borderRadius: 5, padding: 7, font: "inherit", fontSize: 12.5, lineHeight: 1.5, boxSizing: "border-box" }}
                />
              </div>
              <IconBtn tone="danger" size={24} onClick={() => onRemove(m)} title="Xoá yêu cầu sửa đổi">
                <X size={13} />
              </IconBtn>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 7, alignItems: "flex-start" }}>
        <select value={section} onChange={(e) => setSection(e.target.value)} style={{ ...inputStyle, width: 105 }}>
          <option value="content">content</option>
          <option value="assessment">assessment</option>
          <option value="decision">decision</option>
        </select>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Nội dung yêu cầu sửa đổi/bổ sung..."
          style={{ ...inputStyle, flex: 1, minHeight: 58, resize: "vertical", lineHeight: 1.5 }}
        />
        <button onClick={add} style={{ ...btnPrimaryStyle, whiteSpace: "nowrap" }}>Thêm</button>
      </div>

      <div style={{ textAlign: "right", marginTop: 8 }}>
        <button onClick={onClose} style={btnGhostStyle}>Xong</button>
      </div>
    </div>
  );
}

/* ---------------------------- unit form (add/edit) ---------------------------- */

function UnitForm({ initial, parties, onSave, onCancel }) {
  const [type, setType] = useState(initial?.type || "claim");
  const [assertedBy, setAssertedBy] = useState(initial?.assertedBy || []);
  const [text, setText] = useState(initial?.text || "");
  const [order, setOrder] = useState(initial?.order ?? 1);

  const toggleParty = (id) =>
    setAssertedBy((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div style={{
      padding: 14, borderRadius: 10, border: `1px solid ${T.gold}`,
      background: T.goldTint + "55", marginBottom: 12,
    }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Loại unit</label>
          <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle} disabled={!!initial}>
            <option value="claim">Claim</option>
            <option value="request">Request</option>
          </select>
        </div>
        <div style={{ width: 90 }}>
          <label style={labelStyle}>Thứ tự</label>
          <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value))} style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>{type === "request" ? "requested_by" : "asserted_by"} (chọn một hoặc nhiều party)</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {parties.map((p) => {
          const active = assertedBy.includes(p.id);
          const style = PARTY_STYLE[sideOf(p.id)];
          return (
            <button
              key={p.id} onClick={() => toggleParty(p.id)}
              style={{
                padding: "5px 11px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600,
                border: `1.5px solid ${style.base}`,
                background: active ? style.base : "transparent",
                color: active ? "#fff" : style.deep,
              }}
            >
              {p.name} · {p.role}
            </button>
          );
        })}
      </div>

      <label style={labelStyle}>Nội dung</label>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)}
        style={{ ...inputStyle, minHeight: 90, resize: "vertical", lineHeight: 1.6 }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button onClick={onCancel} style={btnGhostStyle}>Huỷ</button>
        <button
          onClick={() => text.trim() && assertedBy.length > 0 && onSave({ type, assertedBy, text: text.trim(), order })}
          style={btnPrimaryStyle}
        >
          Lưu
        </button>
      </div>
    </div>
  );
}

function ReasonDecisionForm({ initial, onSave, onCancel, kind }) {
  const [text, setText] = useState(initial?.text || "");
  const [order, setOrder] = useState(initial?.order ?? 1);
  return (
    <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${T.gold}`, background: T.goldTint + "55", marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ width: 90 }}>
          <label style={labelStyle}>Thứ tự</label>
          <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value))} style={inputStyle} />
        </div>
      </div>
      <label style={labelStyle}>Nội dung {kind === "reasoning" ? "lý do (nhận định)" : "quyết định"}</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ ...inputStyle, minHeight: 90, resize: "vertical", lineHeight: 1.6 }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button onClick={onCancel} style={btnGhostStyle}>Huỷ</button>
        <button onClick={() => text.trim() && onSave({ text: text.trim(), order })} style={btnPrimaryStyle}>Lưu</button>
      </div>
    </div>
  );
}

/* ---------------------------- unit card ---------------------------- */

function UnitCard({ unit, parties, editing, modificationEditing, onConfirm, onEditStart, onEditSave, onEditCancel, onDelete, onModificationToggle, onAddModification, onUpdateModification, onRemoveModification }) {
  const primaryParty = unit.assertedBy?.[0];
  const style = PARTY_STYLE[sideOf(primaryParty)];
  const isRequest = unit.type === "request";

  if (editing) {
    return <UnitForm initial={unit} parties={parties} onSave={onEditSave} onCancel={onEditCancel} />;
  }

  const modifications = unit.modification_spans || [];

  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 2 }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", background: style.base, color: "#fff",
          fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>{unit.order}</div>
        <div style={{ width: 2, flex: 1, background: T.line, marginTop: 2 }} />
      </div>

      <div style={{
        flex: 1, background: T.paperCard, borderRadius: 10,
        border: `1px solid ${T.line}`, borderLeft: `${isRequest ? 5 : 3}px solid ${style.base}`,
        padding: "11px 14px 12px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{
              fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, fontWeight: 700,
              color: style.deep, background: style.tint, padding: "2px 7px", borderRadius: 5,
            }}>{unit.id}</span>
            <span style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
              color: isRequest ? T.gold : T.inkSoft,
            }}>{isRequest ? "Request" : "Claim"}</span>
            {unit.assertedBy?.map((id) => <PartyTag key={id} id={id} parties={parties} />)}
            {isRequest && unit.outcome && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: "#3D6944", background: "#E9F2E7",
                padding: "2px 8px", borderRadius: 20,
              }}>{OUTCOME_LABEL[unit.outcome] || unit.outcome}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <IconBtn title="Sửa" onClick={onEditStart}><Pencil size={14} /></IconBtn>
            <IconBtn title="Xoá" tone="danger" onClick={onDelete}><Trash2 size={14} /></IconBtn>
          </div>
        </div>

        <p style={{
          margin: "0 0 8px", fontSize: isRequest ? 14 : 13.5, lineHeight: 1.65,
          color: T.ink, fontWeight: isRequest ? 500 : 400,
        }}>{unit.text}</p>

        {isRequest && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={onModificationToggle} style={{ ...btnGhostStyle, fontSize: 11.5, padding: "4px 9px" }}>
              {modifications.length ? `${modifications.length} yêu cầu sửa đổi/bổ sung` : "+ yêu cầu sửa đổi/bổ sung"}
            </button>
            <ConfirmToggle status={unit.status} onClick={onConfirm} />
          </div>
        )}

        {!isRequest && <div style={{ textAlign: "right" }}><ConfirmToggle status={unit.status} onClick={onConfirm} /></div>}

        {modificationEditing && (
          <ModificationList
            unit={unit}
            onAdd={onAddModification}
            onUpdate={onUpdateModification}
            onRemove={onRemoveModification}
            onClose={onModificationToggle}
          />
        )}
      </div>
    </div>
  );
}

function SimpleCard({ item, kind, editing, onConfirm, onEditStart, onEditSave, onEditCancel, onDelete }) {
  if (editing) return <ReasonDecisionForm initial={item} kind={kind} onSave={onEditSave} onCancel={onEditCancel} />;
  const accent = kind === "reasoning" ? "#5B6B93" : T.gold;
  const accentTint = kind === "reasoning" ? "#E7EAF3" : T.goldTint;
  return (
    <div style={{
      background: T.paperCard, borderRadius: 10, border: `1px solid ${T.line}`,
      borderLeft: `3px solid ${accent}`, padding: "11px 14px 12px", marginBottom: 10,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <span style={{
          fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, fontWeight: 700,
          color: accent, background: accentTint, padding: "2px 7px", borderRadius: 5,
        }}>
          {item.id}
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          <IconBtn title="Sửa" onClick={onEditStart}><Pencil size={14} /></IconBtn>
          <IconBtn title="Xoá" tone="danger" onClick={onDelete}><Trash2 size={14} /></IconBtn>
        </div>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 13.5, lineHeight: 1.65, color: T.ink }}>{item.text}</p>
      <div style={{ textAlign: "right" }}>
        <ConfirmToggle status={item.status} onClick={onConfirm} />
      </div>
    </div>
  );
}

/* ---------------------------- links tab ---------------------------- */

function LinksTab({ caseData, updateCase }) {
  const requests = caseData.units.filter((u) => u.type === "request");

  const patchRequest = (id, patch) =>
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    }));

  const toggle = (req, kind, targetId) => {
    const key = kind === "decision" ? "linkedDecisions" : "linkedReasoning";
    const cur = req[key] || [];
    const next = cur.includes(targetId) ? cur.filter((x) => x !== targetId) : [...cur, targetId];
    patchRequest(req.id, { [key]: next, linksConfirmed: false });
  };

  if (requests.length === 0) {
    return <p style={{ color: T.inkSoft, fontSize: 13 }}>Chưa có request nào để liên kết.</p>;
  }

  return (
    <div>
      {requests.map((req) => (
        <div key={req.id} style={{
          background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 10,
          padding: "12px 14px", marginBottom: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{
              fontFamily: "ui-monospace, monospace", fontSize: 11.5, fontWeight: 700,
              color: PARTY_STYLE.P.deep, background: PARTY_STYLE.P.tint, padding: "2px 7px", borderRadius: 5,
            }}>{req.id}</span>
            <span style={{ fontSize: 13, color: T.ink, lineHeight: 1.4 }}>
              {req.text.length > 90 ? req.text.slice(0, 90) + "…" : req.text}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <label style={labelStyle}>Liên kết Decision</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {caseData.decisions.length === 0 && <span style={{ fontSize: 12, color: T.inkSoft }}>Chưa có decision</span>}
                {caseData.decisions.map((d) => (
                  <label key={d.id} style={checkRowStyle}>
                    <input type="checkbox" checked={req.linkedDecisions?.includes(d.id) || false}
                      onChange={() => toggle(req, "decision", d.id)} />
                    <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color: T.gold }}>{d.id}</span>
                    <span style={{ color: T.inkSoft }}>{d.text.slice(0, 40)}…</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Liên kết Reasoning</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 130, overflowY: "auto" }}>
                {caseData.reasoning.length === 0 && <span style={{ fontSize: 12, color: T.inkSoft }}>Chưa có reasoning</span>}
                {caseData.reasoning.map((r) => (
                  <label key={r.id} style={checkRowStyle}>
                    <input type="checkbox" checked={req.linkedReasoning?.includes(r.id) || false}
                      onChange={() => toggle(req, "reasoning", r.id)} />
                    <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "#5B6B93" }}>{r.id}</span>
                    <span style={{ color: T.inkSoft }}>{r.text.slice(0, 40)}…</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Outcome</label>
              <select
                value={req.outcome || ""}
                onChange={(e) => patchRequest(req.id, { outcome: e.target.value || null, linksConfirmed: false })}
                style={{ ...inputStyle, width: 220, padding: "6px 9px" }}
              >
                <option value="">— chưa chọn —</option>
                <option value="accepted">Chấp nhận</option>
                <option value="rejected">Không chấp nhận</option>
                <option value="partial">Chấp nhận một phần</option>
              </select>
            </div>
            <button
              onClick={() => patchRequest(req.id, { linksConfirmed: !req.linksConfirmed })}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600,
                border: `1px solid ${req.linksConfirmed ? "#5C8A63" : T.lineStrong}`,
                background: req.linksConfirmed ? "#E9F2E7" : T.paperCard,
                color: req.linksConfirmed ? "#3D6944" : T.inkSoft,
              }}
            >
              <Link2 size={13} />
              {req.linksConfirmed ? "Links & outcome đã xác nhận" : "Xác nhận links & outcome"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------- document (PDF) panel ---------------------------- */

/* Data source for this panel:
   1. If `caseData.pages` holds real OCR page content (an object keyed "1".."N" or an
      array of page strings), those pages are concatenated into one continuous document.
   2. Otherwise — which is the case for the current corpus — there is no page-level
      text, so we synthesize a plain-text "document" from the annotation data itself:
      title, parties, and the ordered claims / requests / reasoning / decisions.
   The text is rendered on a single continuous page that wraps naturally and scrolls
   vertically, so it never escapes the panel.
*/
function buildDocumentText(caseData) {
  const lines = [];
  const title = (caseData.title || `Case ${caseData.id}`).trim();
  if (title) {
    lines.push(title.toUpperCase());
    lines.push("");
  }

  const parties = caseData.parties || [];
  if (parties.length) {
    parties.forEach((p) => lines.push(`${p.name} — ${p.role || "Đương sự"}`));
    lines.push("");
  }

  const units = [...(caseData.units || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const claims = units.filter((u) => u.type !== "request");
  const requests = units.filter((u) => u.type === "request");
  const reasoning = [...(caseData.reasoning || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const decisions = [...(caseData.decisions || [])].sort((a, b) => (a.order || 0) - (b.order || 0));

  const pushSection = (header, items) => {
    const texts = items.map((it) => (it.text || "").trim()).filter(Boolean);
    if (!texts.length) return;
    lines.push(header);
    lines.push("");
    texts.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push("");
  };

  pushSection("NỘI DUNG VỤ ÁN", claims);
  pushSection("YÊU CẦU CỦA ĐƯƠNG SỰ", requests);
  pushSection("NHẬN ĐỊNH CỦA TOÀ ÁN", reasoning);
  pushSection("QUYẾT ĐỊNH", decisions);

  return lines.join("\n").trim() || "(Chưa có nội dung số hoá cho case này)";
}

function documentText(caseData) {
  const raw = caseData.pages;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => raw[k]).join("\n\n");
  }
  if (Array.isArray(raw) && raw.length) return raw.map((x) => String(x)).join("\n\n");
  return buildDocumentText(caseData);
}

function DocumentPanel({ caseData }) {
  const [zoom, setZoom] = useState(100);
  const text = useMemo(() => documentText(caseData), [caseData]);
  const fontSize = 13.5 * (zoom / 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: T.paperDim }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        padding: "8px 14px", borderBottom: `1px solid ${T.line}`, background: T.paperCard, flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <ScrollText size={15} color={T.inkSoft} style={{ flexShrink: 0 }} />
          <span style={{
            fontSize: 12.5, fontWeight: 600, color: T.ink,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {caseData.sourceFile || `Case ${caseData.id}`}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <IconBtn size={24} onClick={() => setZoom((z) => Math.max(60, z - 10))} title="Thu nhỏ"><ZoomOut size={14} /></IconBtn>
          <span style={{ fontSize: 11.5, color: T.inkSoft, width: 36, textAlign: "center" }}>{zoom}%</span>
          <IconBtn size={24} onClick={() => setZoom((z) => Math.min(180, z + 10))} title="Phóng to"><ZoomIn size={14} /></IconBtn>
        </div>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
        padding: "22px 24px", boxSizing: "border-box",
      }}>
        <div style={{
          maxWidth: 760, margin: "0 auto", background: "#fff",
          boxShadow: "0 1px 3px rgba(28,38,36,0.12), 0 1px 1px rgba(28,38,36,0.08)",
          borderRadius: 2, padding: "40px 44px", boxSizing: "border-box",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize, lineHeight: 1.85, color: "#22201A",
          whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word",
        }}>
          {text}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- shared styles ---------------------------- */

const labelStyle = { display: "block", fontSize: 11, fontWeight: 700, color: T.inkSoft, marginBottom: 5, letterSpacing: 0.2 };
const inputStyle = { width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${T.lineStrong}`, fontSize: 13, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" };
const btnPrimaryStyle = { padding: "7px 14px", borderRadius: 7, border: "none", background: T.ink, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const btnGhostStyle = { padding: "7px 14px", borderRadius: 7, border: `1px solid ${T.lineStrong}`, background: "transparent", color: T.inkSoft, fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const checkRowStyle = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" };

/* ---------------------------- data normalization ---------------------------- */

const normalizePartyRole = (role) => ({
  PLAINTIFF: "Nguyên đơn",
  DEFENDANT: "Bị đơn",
  RELATED_PARTY: "Đương sự liên quan",
}[role] || role || "Đương sự");

const normalizeOutcome = (outcome) => ({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  PARTIAL: "partial",
}[String(outcome || "").toUpperCase()] || null);

const normalizeText = (item) => item?.text ?? item?.span?.text ?? "";

const normalizeCase = (source) => {
  if (!source) throw new Error("Case rỗng.");

  // Internal app schema
  if (source.id != null && Array.isArray(source.units)) {
    return {
      ...source,
      id: String(source.id),
      title: source.title || `Case ${source.id}`,
      sourceFile: source.sourceFile || `case_${source.id}`,
      totalPages: source.totalPages != null ? Number(source.totalPages) : 0,
      parties: source.parties || [],
      units: source.units.map((u) => ({
        ...u,
        assertedBy: u.assertedBy || u.requestedBy || [],
        text: u.text || normalizeText(u),
        modification_spans: u.modification_spans || [],
      })),
      reasoning: source.reasoning || [],
      decisions: source.decisions || [],
      pages: source.pages || {},
    };
  }

  // Raw prototype schema
  if (source.case_id == null) throw new Error("Không nhận diện được schema case.");

  const parties = (source.parties || []).map((p) => ({
    id: String(p.party_id),
    name: p.name,
    role: normalizePartyRole(p.procedural_role),
  }));

  const claims = (source.claims || []).map((c) => ({
    id: String(c.claim_id),
    type: "claim",
    order: Number(c.order) || 0,
    assertedBy: Array.isArray(c.asserted_by) ? c.asserted_by.map(String) : (c.asserted_by ? [String(c.asserted_by)] : []),
    text: normalizeText(c),
    status: "unconfirmed",
    section: c.section || "content",
    modification_spans: [],
  }));

  const requests = (source.requests || []).map((r) => ({
    id: String(r.request_id),
    type: "request",
    order: Number(r.order) || 0,
    assertedBy: Array.isArray(r.requested_by) ? r.requested_by.map(String) : (r.requested_by ? [String(r.requested_by)] : []),
    text: normalizeText(r),
    status: "unconfirmed",
    section: r.section || "content",
    modification_spans: (r.modification_spans || []).map((m) => ({
      order: Number(m.order) || 0,
      section: m.section || "content",
      text: m.text || "",
    })),
    outcome: normalizeOutcome((source.request_outcomes || []).find((x) => x.request_id === r.request_id)?.outcome),
    linkedDecisions: (source.request_decision_links || [])
      .filter((x) => x.request_id === r.request_id)
      .map((x) => String(x.decision_id)),
    linkedReasoning: (source.request_reasoning_links || [])
      .filter((x) => x.request_id === r.request_id)
      .map((x) => String(x.reasoning_id)),
    linksConfirmed: false,
  }));

  const reasoning = (source.reasonings || []).map((r) => ({
    id: String(r.reasoning_id),
    order: Number(r.order) || 0,
    text: normalizeText(r),
    status: "unconfirmed",
    section: r.section || "assessment",
  }));

  const decisions = (source.decisions || []).map((d) => ({
    id: String(d.decision_id),
    order: Number(d.order) || 0,
    text: normalizeText(d),
    status: "unconfirmed",
    section: d.section || "decision",
  }));

  return {
    id: String(source.case_id),
    title: `Case ${source.case_id}`,
    sourceFile: `case_${source.case_id}`,
    totalPages: 0,
    parties,
    units: [...claims, ...requests],
    reasoning,
    decisions,
    pages: {},
  };
};

const normalizeCasesPayload = (payload) => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.cases)
      ? payload.cases
      : [payload];
  return list.map(normalizeCase);
};

const INITIAL_CASES = normalizeCasesPayload(rawPrototypeCases);

/* ============================================================================
   HƯỚNG DẪN SỬ DỤNG — nội dung theo tab + tổng quan (dành cho luật sư)
   ============================================================================ */

const HELP_OVERVIEW = {
  title: "Quy trình gán nhãn vụ án",
  steps: [
    {
      title: "1. Phân đoạn",
      text: "Tách bản án thành Claims (tình tiết), Requests (yêu cầu), Reasoning (nhận định) và Decisions (quyết định) trong từng tab tương ứng.",
    },
    {
      title: "2. Ghép nối",
      text: "Trong tab Links, với mỗi Request hãy tích chọn các Reasoning và Decision làm căn cứ cho yêu cầu đó.",
    },
    {
      title: "3. Gán Outcome",
      text: "Cũng trong tab Links, chọn kết quả (Chấp nhận / Không chấp nhận / Chấp nhận một phần) rồi bấm 'Xác nhận links & outcome'.",
    },
  ],
};

const HELP_TABS = {
  claims: {
    title: "Phân đoạn Claim",
    intro: "Claim là tình tiết, sự kiện, lời trình bày của đương sự (thuộc phần nội dung vụ án).",
    steps: [
      "Bấm 'Thêm claim'.",
      "Chọn bên khởi xướng (Nguyên đơn / Bị đơn / Đương sự liên quan).",
      "Nhập nội dung trích nguyên văn từ bản án ở khung bên phải.",
      "Chỉnh 'Thứ tự' cho khớp trình tự bản án rồi bấm 'Lưu'.",
      "Rà soát xong, bấm 'Xác nhận' để đánh dấu đã duyệt.",
    ],
  },
  requests: {
    title: "Phân đoạn Request",
    intro: "Request là yêu cầu khởi kiện / yêu cầu cụ thể của đương sự.",
    steps: [
      "Bấm 'Thêm request'.",
      "Chọn một hoặc nhiều bên yêu cầu.",
      "Nhập nội dung yêu cầu từ bản án.",
      "Nếu có yêu cầu sửa đổi/bổ sung phát sinh, bấm '+ yêu cầu sửa đổi/bổ sung' để thêm.",
      "Bấm 'Xác nhận' khi đã hoàn chỉnh.",
    ],
  },
  reasoning: {
    title: "Phân đoạn Reasoning",
    intro: "Reasoning là nhận định, lập luận của Toà án (phần 'xét thấy').",
    steps: [
      "Bấm 'Thêm reasoning'.",
      "Nhập nội dung nhận định của Toà.",
      "Chỉnh 'Thứ tự' rồi bấm 'Lưu'.",
      "Bấm 'Xác nhận' sau khi rà soát.",
    ],
  },
  decisions: {
    title: "Phân đoạn Decision",
    intro: "Decision là quyết định cuối cùng của Toà án.",
    steps: [
      "Bấm 'Thêm decision'.",
      "Nhập nội dung quyết định.",
      "Chỉnh 'Thứ tự' rồi bấm 'Lưu'.",
      "Bấm 'Xác nhận' sau khi rà soát.",
    ],
  },
  links: {
    title: "Ghép nối & gán Outcome",
    intro: "Với mỗi Request, xác định Reasoning/Decision làm căn cứ và gán kết quả.",
    steps: [
      "Chọn Request cần xử lý.",
      "Ở 'Liên kết Decision': tích chọn quyết định tương ứng.",
      "Ở 'Liên kết Reasoning': tích chọn nhận định làm căn cứ.",
      "Ở 'Outcome': chọn 'Chấp nhận' / 'Không chấp nhận' / 'Chấp nhận một phần'.",
      "Bấm 'Xác nhận links & outcome' để chốt.",
    ],
  },
};

function HelpPanel({ tab, onClose }) {
  const h = HELP_TABS[tab] || {
    title: "Hướng dẫn chung",
    intro: "Xem từng tab để biết cách phân đoạn, ghép nối và gán kết quả.",
    steps: HELP_OVERVIEW.steps.map((s) => `${s.title} — ${s.text}`),
  };
  return (
    <div style={{
      position: "absolute", top: 8, right: 8, width: 320, maxWidth: "calc(100% - 16px)",
      background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12,
      boxShadow: "0 12px 40px rgba(28,38,36,0.18)", padding: "15px 16px 14px",
      zIndex: 60, maxHeight: "calc(100% - 16px)", overflowY: "auto", boxSizing: "border-box",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CircleHelp size={16} color={T.gold} />
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{h.title}</span>
        </div>
        <IconBtn size={24} onClick={onClose} title="Đóng hướng dẫn"><X size={14} /></IconBtn>
      </div>
      {h.intro && <p style={{ margin: "0 0 10px", fontSize: 12.5, color: T.inkSoft, lineHeight: 1.55 }}>{h.intro}</p>}
      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
        {(h.steps || []).map((s, i) => (
          <li key={i} style={{ fontSize: 12.5, color: T.ink, lineHeight: 1.5 }}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

function OnboardingModal({ onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(28,38,36,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100, padding: 20, boxSizing: "border-box",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: "100%", background: T.paperCard, borderRadius: 14,
          padding: "26px 28px", boxShadow: "0 20px 60px rgba(28,38,36,0.30)",
          maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: T.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <GraduationCap size={17} />
          </div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Hướng dẫn gán nhãn vụ án</h2>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: T.inkSoft }}>
          Dành cho luật sư: quy trình gồm 3 bước chính.
        </p>

        {HELP_OVERVIEW.steps.map((s) => (
          <div key={s.title} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.gold, marginBottom: 3 }}>{s.title}</div>
            <div style={{ fontSize: 12.5, color: T.ink, lineHeight: 1.6 }}>{s.text}</div>
          </div>
        ))}

        <div style={{ background: T.paperDim, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: T.inkSoft, lineHeight: 1.6, marginBottom: 16 }}>
          Trong mỗi case, bấm biểu tượng <CircleHelp size={13} style={{ verticalAlign: "-2px" }} color={T.gold} /> ở góc trên phải để xem hướng dẫn theo từng tab.
        </div>

        <div style={{ textAlign: "right" }}>
          <button onClick={onClose} style={btnPrimaryStyle}>Bắt đầu làm việc</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   LOGIN — hai vai trò: Annotator (tên + mã) và Admin (user + mật khẩu)
   ============================================================================ */

function LoginScreen({ onLogin, offline }) {
  const [mode, setMode] = useState("annotator"); // "annotator" | "admin"
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const submit = async (e) => {
    if (e) e.preventDefault();
    setError("");
    if (mode === "annotator" && !name.trim()) { setError("Nhập tên annotator."); return; }
    if (mode === "annotator" && !passcode) { setError("Nhập mã annotator."); return; }
    if (mode === "admin" && (!username.trim() || !password)) { setError("Nhập tên đăng nhập và mật khẩu."); return; }
    setBusy(true);
    try {
      await onLogin(
        mode === "admin"
          ? { mode, username: username.trim(), password }
          : { mode, name: name.trim(), passcode }
      );
    } catch (err) {
      setError(err.message || "Đăng nhập thất bại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.paper }}>
      <div style={{ width: 400, background: T.paperCard, borderRadius: 14, border: `1px solid ${T.line}`, padding: "26px 28px", boxShadow: "0 8px 30px rgba(28,38,36,0.10)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: T.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Gavel size={17} />
          </div>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Legal Annotation</h1>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: T.inkSoft }}>
          Hệ thống gán nhãn vụ án dân sự — dành cho admin và annotator.
        </p>

        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${T.line}` }}>
          {[["annotator", "Annotator", UserRound], ["admin", "Admin", Shield]].map(([k, label, Icon]) => {
            const active = mode === k;
            return (
              <button
                key={k}
                onClick={() => { setMode(k); setError(""); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
                  fontSize: 12.5, fontWeight: 600, border: "none", cursor: "pointer",
                  background: "transparent", color: active ? T.ink : T.inkSoft,
                  borderBottom: active ? `2px solid ${T.gold}` : "2px solid transparent",
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>

        {mode === "annotator" ? (
          <>
            <label style={labelStyle}>Tên annotator</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Luật sư Minh" style={{ ...inputStyle, marginBottom: 12 }} />
            <label style={labelStyle}>Mã annotator (do admin cấp)</label>
            <input value={passcode} onChange={(e) => setPasscode(e.target.value)} type="password" placeholder="Mã của bạn" style={{ ...inputStyle, marginBottom: 12 }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </>
        ) : (
          <>
            <label style={labelStyle}>Tên đăng nhập</label>
            <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" style={{ ...inputStyle, marginBottom: 12 }} />
            <label style={labelStyle}>Mật khẩu</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="••••••••" style={{ ...inputStyle, marginBottom: 12 }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </>
        )}

        {error && <p style={{ color: T.danger, fontSize: 12, margin: "0 0 10px" }}>{error}</p>}
        {offline && (
          <p style={{ color: T.danger, fontSize: 12, margin: "0 0 10px" }}>
            Không kết nối được backend tại {API_BASE}. Hãy khởi động backend trước.
          </p>
        )}

        <button onClick={submit} disabled={busy} style={{ ...btnPrimaryStyle, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {busy ? "Đang đăng nhập…" : "Vào làm việc"}
        </button>

        <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 12 }}>
          <button
            onClick={() => setShowHelp((v) => !v)}
            style={{ ...btnGhostStyle, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 10px", fontSize: 12 }}
          >
            <BookOpen size={13} /> {showHelp ? "Ẩn quy trình gán nhãn" : "Xem quy trình gán nhãn"}
          </button>
          {showHelp && (
            <div style={{ marginTop: 10, background: T.paperDim, borderRadius: 8, padding: "10px 12px" }}>
              {HELP_OVERVIEW.steps.map((s) => (
                <div key={s.title} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.gold }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: T.inkSoft, lineHeight: 1.55 }}>{s.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   DASHBOARD ANNOTATOR — chỉ thấy case được phân công, chưa hoàn thành
   ============================================================================ */

function AnnotatorDashboard({ cases, stats, onOpen, onRefresh, refreshing, flash, onShowGuide }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showGuide, setShowGuide] = useState(true);
  const pageSize = 20;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((c) => !q || c.case_id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  }, [cases, search]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div style={{ padding: "18px 22px", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Case của tôi</h2>
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: T.inkSoft }}>
            Đã giao {stats.assigned} · Đã hoàn thành {stats.completed} · Còn lại {stats.remaining}
          </p>
        </div>
        <button onClick={onRefresh} disabled={refreshing} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}>
          {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Làm mới
        </button>
      </div>

      <div style={{ background: T.goldTint, border: `1px solid ${T.gold}55`, borderRadius: 10, padding: "11px 14px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Lightbulb size={14} color={T.gold} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: T.ink }}>Hướng dẫn nhanh</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onShowGuide?.()} style={{ ...btnGhostStyle, padding: "4px 9px", fontSize: 11.5 }}>Xem đầy đủ</button>
            <button onClick={() => setShowGuide((v) => !v)} style={{ ...btnGhostStyle, padding: "4px 9px", fontSize: 11.5 }}>{showGuide ? "Ẩn" : "Hiện"}</button>
          </div>
        </div>
        {showGuide && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {HELP_OVERVIEW.steps.map((s) => (
              <div key={s.title} style={{ fontSize: 12, color: T.ink, lineHeight: 1.5 }}>
                <strong style={{ color: T.gold }}>{s.title}.</strong> {s.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {flash && (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: "#3D6944", background: "#E9F2E7", padding: "8px 12px", borderRadius: 8 }}>{flash}</div>
      )}

      <input
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        placeholder="Tìm theo mã case hoặc tiêu đề…"
        style={{ ...inputStyle, marginBottom: 14, maxWidth: 380 }}
      />

      {filtered.length === 0 && (
        <p style={{ color: T.inkSoft, fontSize: 13 }}>
          {stats.assigned === 0
            ? "Bạn chưa được phân công case nào. Hãy liên hệ admin."
            : "Không có case nào phù hợp."}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {visible.map((c) => (
          <div key={c.case_id} style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12, padding: "13px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, fontWeight: 700, background: T.paperDim, padding: "3px 8px", borderRadius: 6 }}>Case {c.case_id}</span>
              {c.submitted && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#3D6944", background: "#E9F2E7", padding: "2px 8px", borderRadius: 20, flexShrink: 0 }}>Đã nộp</span>
              )}
              <span style={{ fontSize: 12.5, color: T.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
            </div>
            <button onClick={() => onOpen(c.case_id)} style={{ ...btnPrimaryStyle, flexShrink: 0 }}>Mở case</button>
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, justifyContent: "center" }}>
          <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} style={btnGhostStyle}><ChevronLeft size={14} /></button>
          <span style={{ fontSize: 12.5, color: T.inkSoft }}>Trang {safePage} / {pages}</span>
          <button disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} style={btnGhostStyle}><ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   DASHBOARD ADMIN — quản lý annotator + case (phân công / mở lại / import)
   ============================================================================ */

function AdminDashboard({
  overview, annotators, admins, progress, currentUsername,
  onOpenCase, onAssign, onReopen, onAutoAssign,
  onImportFile, onImportPrototype, importMessage,
  onCreateAnnotator, onResetPasscode, onDeleteAnnotator,
  onCreateAdmin, onResetAdminPassword, onDeleteAdmin,
  onDeleteSubmissions,
  onClearAssignments,
  onRefresh, refreshing, flash, onExport,
}) {
  const [section, setSection] = useState("cases"); // "cases" | "annotators" | "admins" | "progress"
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | open | completed | unassigned
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [newName, setNewName] = useState("");
  const [newPasscode, setNewPasscode] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  const [resetPass, setResetPass] = useState({});
  const [adminUsername, setAdminUsername] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminResetPass, setAdminResetPass] = useState({});
  const importRef = useRef(null);

  const nameOf = (id) => annotators.find((a) => a.id === id)?.name || id || "";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return overview.filter((c) => {
      if (q && !c.case_id.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q)) return false;
      if (filter === "open" && c.status !== "open") return false;
      if (filter === "completed" && c.status !== "completed") return false;
      if (filter === "unassigned" && (c.assigned_to || []).length) return false;
      return true;
    });
  }, [overview, search, filter]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const openCount = overview.filter((c) => c.status === "open").length;
  const completedCount = overview.length - openCount;
  const unassignedCount = overview.filter((c) => c.status === "open" && !(c.assigned_to || []).length).length;

  const tabBase = {
    display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
    fontSize: 12.5, fontWeight: 600, border: "none", cursor: "pointer",
    background: "transparent", color: T.inkSoft,
    borderBottom: "2px solid transparent",
  };

  return (
    <div style={{ padding: "18px 22px", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Quản lý hệ thống</h2>
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: T.inkSoft }}>
            {overview.length} case · {openCount} mở · {completedCount} hoàn thành · {unassignedCount} chưa giao
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {section === "cases" && (
            <>
              <button onClick={onAutoAssign} style={btnPrimaryStyle}>Phân công tự động</button>
              <button onClick={onClearAssignments} style={{ ...btnGhostStyle, color: T.danger, borderColor: T.danger + "66" }}>Xoá toàn bộ phân công</button>
              <button onClick={onImportPrototype} style={btnGhostStyle}>Nạp 10 case mẫu</button>
              <button onClick={() => importRef.current?.click()} style={btnGhostStyle}>Import JSON</button>
            </>
          )}
          <button onClick={() => onExport("json")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }} title="Tải toàn bộ submission (payload đầy đủ) dạng JSON">
            <Download size={13} /> Tải dữ liệu (JSON)
          </button>
          <button onClick={() => onExport("csv")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }} title="Tải bảng tóm tắt CSV (mở bằng Excel)">
            <Download size={13} /> Tải summary (CSV)
          </button>
          <button onClick={onRefresh} disabled={refreshing} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}>
            {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Làm mới
          </button>
        </div>
      </div>
      <input ref={importRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = ""; }} />

      {flash && (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: "#3D6944", background: "#E9F2E7", padding: "8px 12px", borderRadius: 8 }}>{flash}</div>
      )}
      {importMessage && (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: importMessage.startsWith("Không") || importMessage.includes("thất bại") ? T.danger : "#3D6944", background: T.paperDim, padding: "8px 12px", borderRadius: 8 }}>{importMessage}</div>
      )}

      <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${T.line}` }}>
        <button onClick={() => setSection("cases")} style={{ ...tabBase, color: section === "cases" ? T.ink : T.inkSoft, borderBottom: section === "cases" ? `2px solid ${T.gold}` : "2px solid transparent" }}>
          <ListChecks size={14} /> Vụ án ({overview.length})
        </button>
        <button onClick={() => setSection("annotators")} style={{ ...tabBase, color: section === "annotators" ? T.ink : T.inkSoft, borderBottom: section === "annotators" ? `2px solid ${T.gold}` : "2px solid transparent" }}>
          <Users size={14} /> Annotator ({annotators.length})
        </button>
        <button onClick={() => setSection("admins")} style={{ ...tabBase, color: section === "admins" ? T.ink : T.inkSoft, borderBottom: section === "admins" ? `2px solid ${T.gold}` : "2px solid transparent" }}>
          <Shield size={14} /> Admin ({admins.length})
        </button>
        <button onClick={() => setSection("progress")} style={{ ...tabBase, color: section === "progress" ? T.ink : T.inkSoft, borderBottom: section === "progress" ? `2px solid ${T.gold}` : "2px solid transparent" }}>
          <Activity size={14} /> Tiến độ ({progress.length})
        </button>
      </div>

      {section === "cases" && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Tìm theo mã case hoặc tiêu đề…"
              style={{ ...inputStyle, maxWidth: 340 }}
            />
            <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} style={{ ...inputStyle, width: 190 }}>
              <option value="all">Tất cả</option>
              <option value="open">Đang mở</option>
              <option value="completed">Đã hoàn thành</option>
              <option value="unassigned">Chưa phân công</option>
            </select>
          </div>

          {filtered.length === 0 && <p style={{ color: T.inkSoft, fontSize: 13 }}>Không có case nào. Hãy import corpus trước.</p>}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visible.map((c) => (
              <div key={c.case_id} style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12, padding: "13px 16px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, fontWeight: 700, background: T.paperDim, padding: "3px 8px", borderRadius: 6 }}>Case {c.case_id}</span>
                      {c.status === "completed"
                        ? <span style={{ fontSize: 11, fontWeight: 700, color: "#3D6944", background: "#E9F2E7", padding: "2px 8px", borderRadius: 20 }}>Đã hoàn thành{c.completed_by ? ` · ${nameOf(c.completed_by)}` : ""}</span>
                        : <span style={{ fontSize: 11, fontWeight: 700, color: T.gold, background: T.goldTint, padding: "2px 8px", borderRadius: 20 }}>Mở</span>}
                      <span style={{ fontSize: 12, color: T.inkSoft }}>{c.title}</span>
                    </div>

                    <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 8, fontSize: 12 }}>
                      <div style={{ minWidth: 200 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: T.inkSoft, textTransform: "uppercase" }}>Phân công ({c.assigned_to?.length || 0})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 3 }}>
                          {(c.assigned_to || []).length === 0 && <span style={{ color: T.inkSoft }}>Chưa phân công</span>}
                          {(c.assigned_to || []).map((id) => (
                            <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, background: T.paperDim, borderRadius: 12, padding: "2px 8px", alignSelf: "flex-start" }}>
                              {nameOf(id)}
                              <button
                                onClick={() => onAssign(c.case_id, id, true)}
                                title="Bỏ annotator này"
                                style={{ border: "none", background: "transparent", cursor: "pointer", color: T.danger, fontSize: 12, padding: 0, lineHeight: 1 }}
                              >✕</button>
                            </span>
                          ))}
                          <select
                            value=""
                            onChange={(e) => { const v = e.target.value; if (v) onAssign(c.case_id, v); }}
                            style={{ ...inputStyle, padding: "4px 8px", fontSize: 12, width: 200 }}
                          >
                            <option value="">+ thêm annotator…</option>
                            {annotators.map((a) => (
                              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: T.inkSoft, textTransform: "uppercase" }}>Đã gửi</div>
                        <div style={{ marginTop: 3 }}>
                          {c.submissions.length === 0
                            ? <span style={{ color: T.inkSoft }}>Chưa có</span>
                            : c.submissions.map((s) => s.annotator_name || nameOf(s.annotator_id)).join(", ")}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", flexShrink: 0 }}>
                    <button onClick={() => onOpenCase(c.case_id)} style={{ ...btnPrimaryStyle, padding: "5px 12px", fontSize: 12 }}>Mở case</button>
                    {c.status === "completed" && (
                      <button onClick={() => onReopen(c.case_id)} style={{ ...btnGhostStyle, padding: "4px 10px", fontSize: 11.5 }}>Mở lại</button>
                    )}
                    {c.submissions.length > 0 && (
                      <button
                        onClick={() => { if (window.confirm(`Xoá ${c.submissions.length} bài gửi của case ${c.case_id}? Case sẽ mở lại.`)) onDeleteSubmissions(c.case_id); }}
                        style={{ ...btnGhostStyle, padding: "4px 10px", fontSize: 11.5, color: T.danger, borderColor: T.danger + "66" }}
                      >
                        Xoá bài gửi
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {pages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, justifyContent: "center" }}>
              <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} style={btnGhostStyle}><ChevronLeft size={14} /></button>
              <span style={{ fontSize: 12.5, color: T.inkSoft }}>Trang {safePage} / {pages}</span>
              <button disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} style={btnGhostStyle}><ChevronRight size={14} /></button>
            </div>
          )}
        </>
      )}

      {section === "annotators" && (
        <>
          <div style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Tạo annotator mới</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={labelStyle}>Tên</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="VD: Luật sư Minh" style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={labelStyle}>Mã đăng nhập (≥4 ký tự)</label>
                <input value={newPasscode} onChange={(e) => setNewPasscode(e.target.value)} placeholder="VD: Minh@123" style={inputStyle} />
              </div>
              <button
                onClick={async () => {
                  try {
                    const a = await onCreateAnnotator(newName.trim(), newPasscode);
                    setCreateMsg(`Đã tạo ${a.name} — mã đăng nhập: ${a.passcode}. Gửi mã này cho luật sư.`);
                    setNewName(""); setNewPasscode("");
                  } catch (e) {
                    setCreateMsg(e.message || "Tạo annotator thất bại.");
                  }
                }}
                style={btnPrimaryStyle}
              >
                Tạo
              </button>
            </div>
            {createMsg && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "#3D6944", background: "#E9F2E7", padding: "8px 10px", borderRadius: 8 }}>{createMsg}</div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {annotators.map((a) => (
              <div key={a.id} style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <UserRound size={15} color={T.inkSoft} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                  <span style={{ fontSize: 11.5, color: T.inkSoft }}>{a.id}</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="Mã mới"
                    value={resetPass[a.id] || ""}
                    onChange={(e) => setResetPass((p) => ({ ...p, [a.id]: e.target.value }))}
                    style={{ ...inputStyle, width: 130, padding: "5px 8px", fontSize: 12 }}
                  />
                  <button
                    onClick={() => {
                      const code = (resetPass[a.id] || "").trim();
                      if (!code) { setCreateMsg("Nhập mã mới trước."); return; }
                      onResetPasscode(a.id, code);
                      setResetPass((p) => ({ ...p, [a.id]: "" }));
                    }}
                    style={{ ...btnGhostStyle, padding: "5px 10px", fontSize: 11.5 }}
                  >
                    Đổi mã
                  </button>
                  <IconBtn tone="danger" title="Xoá annotator" onClick={() => { if (window.confirm(`Xoá ${a.name}? Phân công của họ sẽ được gỡ.`)) onDeleteAnnotator(a.id); }}>
                    <Trash2 size={14} />
                  </IconBtn>
                </div>
              </div>
            ))}
            {annotators.length === 0 && <p style={{ color: T.inkSoft, fontSize: 13 }}>Chưa có annotator nào. Hãy tạo annotator đầu tiên.</p>}
          </div>
        </>
      )}

      {section === "admins" && (
        <>
          <div style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Tạo admin mới</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={labelStyle}>Username</label>
                <input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} placeholder="VD: boss" style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label style={labelStyle}>Tên hiển thị</label>
                <input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="VD: Quản lý chính" style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label style={labelStyle}>Mật khẩu (≥6 ký tự)</label>
                <input value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} type="password" placeholder="••••••••" style={inputStyle} />
              </div>
              <button
                onClick={async () => {
                  try {
                    const a = await onCreateAdmin(adminUsername.trim(), adminPassword, adminName.trim());
                    setCreateMsg(`Đã tạo admin "${a.username}" (${a.name}).`);
                    setAdminUsername(""); setAdminPassword(""); setAdminName("");
                  } catch (e) {
                    setCreateMsg(e.message || "Tạo admin thất bại.");
                  }
                }}
                style={btnPrimaryStyle}
              >
                Tạo admin
              </button>
            </div>
            {createMsg && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "#3D6944", background: "#E9F2E7", padding: "8px 10px", borderRadius: 8 }}>{createMsg}</div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {admins.map((a) => {
              const isSelf = currentUsername === a.username;
              return (
                <div key={a.username} style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Shield size={15} color={T.gold} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{a.name || a.username}</span>
                    <span style={{ fontSize: 11.5, color: T.inkSoft }}>{a.username}{isSelf ? " (bạn)" : ""}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      placeholder="Mật khẩu mới"
                      type="password"
                      value={adminResetPass[a.username] || ""}
                      onChange={(e) => setAdminResetPass((p) => ({ ...p, [a.username]: e.target.value }))}
                      style={{ ...inputStyle, width: 150, padding: "5px 8px", fontSize: 12 }}
                    />
                    <button
                      onClick={() => {
                        const pw = (adminResetPass[a.username] || "").trim();
                        if (!pw) { setCreateMsg("Nhập mật khẩu mới trước."); return; }
                        onResetAdminPassword(a.username, pw);
                        setAdminResetPass((p) => ({ ...p, [a.username]: "" }));
                      }}
                      style={{ ...btnGhostStyle, padding: "5px 10px", fontSize: 11.5 }}
                    >
                      Đổi mật khẩu
                    </button>
                    <IconBtn tone="danger" title="Xoá admin" onClick={() => { if (window.confirm(`Xoá admin "${a.username}"?`)) onDeleteAdmin(a.username); }}>
                      <Trash2 size={14} />
                    </IconBtn>
                  </div>
                </div>
              );
            })}
            {admins.length === 0 && <p style={{ color: T.inkSoft, fontSize: 13 }}>Chưa có admin nào.</p>}
          </div>
        </>
      )}

      {section === "progress" && (
        <div>
          {progress.length === 0 && (
            <p style={{ color: T.inkSoft, fontSize: 13 }}>Chưa có annotator hoặc chưa có phân công case nào.</p>
          )}
          {progress.map((a) => {
            const pct = Math.max(0, Math.min(100, a.progress_pct || 0));
            const done = pct >= 100;
            const statusStyle = (s) =>
              s === "completed"
                ? { background: "#E9F2E7", color: "#3D6944", borderColor: "#5C8A63" }
                : s === "in_progress"
                  ? { background: T.goldTint, color: T.gold, borderColor: T.gold }
                  : { background: T.paperDim, color: T.inkSoft, borderColor: T.line };
            return (
              <div key={a.id} style={{ background: T.paperCard, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <UserRound size={15} color={T.inkSoft} />
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{a.name}</span>
                    <span style={{ fontSize: 11.5, color: T.inkSoft }}>{a.id}</span>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: done ? "#3D6944" : T.gold }}>
                    {a.completed}/{a.assigned} hoàn thành · {pct}%
                  </span>
                </div>
                <div style={{ height: 8, background: T.paperDim, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: done ? "#5C8A63" : T.gold, transition: "width 200ms ease" }} />
                </div>
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: T.inkSoft, marginBottom: 10 }}>
                  <span><strong style={{ color: "#3D6944" }}>{a.completed}</strong> đã nộp</span>
                  <span><strong style={{ color: T.gold }}>{a.in_progress}</strong> đang làm</span>
                  <span><strong>{a.not_started}</strong> chưa bắt đầu</span>
                  <span><strong>{a.assigned}</strong> được giao</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {a.cases.map((c) => {
                    const st = statusStyle(c.status);
                    return (
                      <span key={c.case_id} title={`${c.case_id} — ${c.status}`} style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12,
                        background: st.background, color: st.color, border: `1px solid ${st.borderColor}`,
                      }}>
                        Case {c.case_id}
                      </span>
                    );
                  })}
                  {a.cases.length === 0 && <span style={{ fontSize: 12, color: T.inkSoft }}>Chưa được phân công case nào.</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   APP CHÍNH
   ============================================================================ */

export default function LegalAnnotationApp() {
  const [auth, setAuth] = useState(() => {
    try {
      const saved = localStorage.getItem("legal-annotation-auth");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [backendOk, setBackendOk] = useState(true);
  const [view, setView] = useState("dashboard"); // "dashboard" | "annotation"

  const [caseData, setCaseData] = useState(null);
  const [tab, setTab] = useState("units");
  const [leftWidth, setLeftWidth] = useState(50);
  const draggingRef = useRef(false);
  const containerRef = useRef(null);

  const [addingType, setAddingType] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [modificationEditId, setModificationEditId] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [draftStatus, setDraftStatus] = useState("idle"); // idle | saving | saved | error
  const [draftLoadedAt, setDraftLoadedAt] = useState(null);
  const dirtyRef = useRef(false);
  const dirtyVersionRef = useRef(0);

  const [flash, setFlash] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // hướng dẫn (help panel trong case + onboarding lần đầu)
  const [helpOpen, setHelpOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // annotator dashboard
  const [myCases, setMyCases] = useState([]);
  const [myStats, setMyStats] = useState({ assigned: 0, completed: 0, remaining: 0 });

  // admin dashboard
  const [adminOverview, setAdminOverview] = useState([]);
  const [adminAnnotators, setAdminAnnotators] = useState([]);
  const [adminAdmins, setAdminAdmins] = useState([]);
  const [adminProgress, setAdminProgress] = useState([]);
  const [importMessage, setImportMessage] = useState("");

  const api = async (path, { method = "GET", body } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch { /* ignore */ }
      const err = new Error(detail || `Lỗi HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  const expireSession = () => {
    setAuth(null);
    localStorage.removeItem("legal-annotation-auth");
    setCaseData(null);
    setView("dashboard");
  };

  const loadAdminData = async () => {
    try {
      const [ov, ann, adm, prog] = await Promise.all([
        api("/api/cases"),
        api("/api/annotators"),
        api("/api/admins"),
        api("/api/admin/progress"),
      ]);
      setAdminOverview(ov);
      setAdminAnnotators(ann);
      setAdminAdmins(adm);
      setAdminProgress(prog.annotators || []);
      setBackendOk(true);
    } catch (e) {
      setBackendOk(false);
      if (e.status === 401) expireSession();
    }
  };

  const loadMyCases = async () => {
    try {
      const res = await api("/api/annotator/cases");
      setMyCases(res.cases);
      setMyStats(res.stats);
      setBackendOk(true);
    } catch (e) {
      setBackendOk(false);
      if (e.status === 401) expireSession();
    }
  };

  /* nạp dữ liệu dashboard sau khi đăng nhập (hoặc khi mở app với phiên đã lưu) */
  useEffect(() => {
    if (!auth) return;
    setView("dashboard");
    setCaseData(null);
    dirtyRef.current = false;
    if (auth.type === "admin") loadAdminData();
    else loadMyCases();
  }, [auth?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* tự động cập nhật tiến độ cho admin (real-time) */
  useEffect(() => {
    if (!auth || auth.type !== "admin") return;
    const id = setInterval(() => { loadAdminData(); }, 15000);
    return () => clearInterval(id);
  }, [auth?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* hiển thị hướng dẫn lần đầu cho annotator (chỉ một lần) */
  useEffect(() => {
    if (!auth || auth.type !== "annotator") return;
    if (!localStorage.getItem("legal-annotation-onboarded")) {
      setShowOnboarding(true);
    }
  }, [auth?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeOnboarding = () => {
    localStorage.setItem("legal-annotation-onboarded", "1");
    setShowOnboarding(false);
  };

  const handleLogin = async ({ mode, username, password, name, passcode }) => {
    const path = mode === "admin" ? "/api/auth/admin" : "/api/auth/annotator";
    const body = mode === "admin" ? { username, password } : { name, passcode };
    const a = await api(path, { method: "POST", body });
    setAuth(a);
    localStorage.setItem("legal-annotation-auth", JSON.stringify(a));
    setBackendOk(true);
    return a;
  };

  const handleLogout = () => {
    expireSession();
    setFlash("");
    setSubmitMessage("");
    setSubmitError("");
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (auth?.type === "admin") await loadAdminData();
      else if (auth?.type === "annotator") await loadMyCases();
    } finally {
      setRefreshing(false);
    }
  };

  const openCase = async (caseId) => {
    try {
      const doc = await api(`/api/cases/${caseId}/doc`);
      setCaseData(doc);
      setTab("units");
      setEditingId(null);
      setModificationEditId(null);
      setAddingType(null);
      setEditingTitle(false);
      setTitleDraft("");
      setSubmitted(false);
      setSubmitError("");
      setSubmitMessage("");
      dirtyRef.current = false;
      setDraftStatus("idle");
      setDraftLoadedAt(null);
      setView("annotation");
      if (auth?.type === "annotator") {
        let restored = false;
        try {
          const d = await api(`/api/cases/${caseId}/draft`);
          if (d?.saved_at) {
            const { saved_at, ...clean } = d;
            setCaseData(clean);
            setDraftLoadedAt(saved_at);
            restored = true;
          }
        } catch { /* chưa có nháp */ }
        if (!restored) {
          try {
            const sub = await api(`/api/cases/${caseId}/submission`);
            setCaseData({
              ...doc,
              title: sub.title || doc.title,
              parties: sub.parties ?? doc.parties ?? [],
              units: sub.units ?? [],
              reasoning: sub.reasoning ?? [],
              decisions: sub.decisions ?? [],
            });
            setSubmitted(true);
            setSubmitMessage("Đã tải lại bài nộp trước đó — bạn có thể chỉnh sửa và gửi lại.");
          } catch { /* chưa có bài nộp */ }
        }
      }
    } catch (e) {
      setFlash(e.message || "Không tải được case.");
    }
  };

  const backToDashboard = () => {
    setView("dashboard");
    setCaseData(null);
    dirtyRef.current = false;
    if (auth?.type === "admin") loadAdminData();
    else loadMyCases();
  };

  /* -------------------- annotation handlers (single case) -------------------- */

  const updateCase = useCallback((fn) => {
    setCaseData((c) => (c ? fn(c) : c));
    dirtyRef.current = true;
    dirtyVersionRef.current += 1;
    setSubmitted(false);
    setDraftStatus("idle");
    setSubmitMessage("");
  }, []);

  const toggleConfirm = (id, group) => {
    updateCase((c) => ({
      ...c,
      [group]: c[group].map((u) => (u.id === id ? { ...u, status: u.status === "confirmed" ? "unconfirmed" : "confirmed" } : u)),
    }));
  };

  const saveNewUnit = (data) => {
    const prefix = data.type === "claim" ? "C" : "R";
    const existingIds = caseData.units.filter((u) => u.id.startsWith(prefix)).map((u) => parseInt(u.id.slice(1)) || 0);
    const nextNum = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const newUnit = { id: `${prefix}${nextNum}`, status: "unconfirmed", modification_spans: [], ...data };
    if (data.type === "request") {
      newUnit.outcome = null;
      newUnit.linkedDecisions = [];
      newUnit.linkedReasoning = [];
      newUnit.linksConfirmed = false;
    }
    updateCase((c) => ({ ...c, units: insertAtOrder(c.units, newUnit, newUnit.order) }));
    setAddingType(null);
  };

  const saveEditUnit = (id, data) => {
    updateCase((c) => ({ ...c, units: c.units.map((u) => (u.id === id ? { ...u, ...data } : u)) }));
    setEditingId(null);
  };

  const deleteUnit = (id) => {
    updateCase((c) => ({ ...c, units: deleteAtOrder(c.units, id) }));
  };

  const toggleModifications = (unitId) => {
    setModificationEditId((id) => (id === unitId ? null : unitId));
  };

  const addModification = (unitId, modification) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => (u.id === unitId ? { ...u, modification_spans: [...(u.modification_spans || []), modification] } : u)),
    }));
  };

  const updateModification = (unitId, target, modification) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => {
        if (u.id !== unitId) return u;
        const list = [...(u.modification_spans || [])];
        const idx = list.indexOf(target);
        if (idx >= 0) list[idx] = modification;
        return { ...u, modification_spans: list };
      }),
    }));
  };

  const removeModification = (unitId, target) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => {
        if (u.id !== unitId) return u;
        return { ...u, modification_spans: (u.modification_spans || []).filter((x) => x !== target) };
      }),
    }));
  };

  const commitTitle = () => {
    const title = titleDraft.trim();
    if (title) updateCase((c) => ({ ...c, title }));
    setEditingTitle(false);
  };

  const saveNewSimple = (kind, data) => {
    const prefix = kind === "reasoning" ? "RE" : "DE";
    const list = caseData[kind];
    const existingIds = list.map((u) => parseInt(u.id.replace(prefix, "")) || 0);
    const nextNum = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const item = { id: `${prefix}${nextNum}`, status: "unconfirmed", ...data };
    updateCase((c) => ({ ...c, [kind]: insertAtOrder(c[kind], item, item.order) }));
    setAddingType(null);
  };

  const saveEditSimple = (kind, id, data) => {
    updateCase((c) => ({ ...c, [kind]: c[kind].map((u) => (u.id === id ? { ...u, ...data } : u)) }));
    setEditingId(null);
  };

  const deleteSimple = (kind, id) => {
    updateCase((c) => ({ ...c, [kind]: deleteAtOrder(c[kind], id) }));
  };

  /* -------------------- autosave nháp (annotator) -------------------- */

  useEffect(() => {
    if (!auth || auth.type !== "annotator" || view !== "annotation" || !caseData || submitted) return;
    if (!dirtyRef.current) return;
    const version = dirtyVersionRef.current;
    const timer = setTimeout(async () => {
      try {
        setDraftStatus("saving");
        const res = await api(`/api/cases/${caseData.id}/draft`, { method: "PUT", body: caseData });
        if (dirtyVersionRef.current === version) {
          dirtyRef.current = false;
          setDraftStatus("saved");
          setDraftLoadedAt(res.saved_at || new Date().toISOString());
        }
        setBackendOk(true);
      } catch {
        setDraftStatus("error");
        setBackendOk(false);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [caseData, auth, view, submitted]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------- submit -------------------- */

  const submitCase = async () => {
    if (!caseData) return;
    setSubmitting(true);
    setSubmitError("");
    setSubmitMessage("");
    try {
      await api("/api/submit", {
        method: "POST",
        body: {
          case_id: caseData.id,
          title: caseData.title,
          parties: caseData.parties,
          units: caseData.units,
          reasoning: caseData.reasoning,
          decisions: caseData.decisions,
          submitted_at: new Date().toISOString(),
        },
      });
      dirtyRef.current = false;
      setDraftStatus("idle");
      setDraftLoadedAt(null);
      setSubmitted(true);
      setSubmitMessage(`Đã gửi bài nộp cho case ${caseData.id}. Bạn vẫn có thể chỉnh sửa và gửi lại.`);
      if (auth?.type === "annotator") loadMyCases();
      else loadAdminData();
    } catch (e) {
      setSubmitError(e.message || "Không thể gửi kết quả.");
    } finally {
      setSubmitting(false);
    }
  };

  /* -------------------- admin actions -------------------- */

  const assignCase = async (caseId, annotatorId, remove = false) => {
    try {
      await api(`/api/cases/${caseId}/assign`, { method: "POST", body: { annotator_id: annotatorId || null, remove } });
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Phân công thất bại.");
    }
  };

  const clearAllAssignments = async () => {
    if (!window.confirm("Xoá toàn bộ phân công của tất cả case? Case sẽ trở về chưa phân công.")) return;
    try {
      await api("/api/assignments", { method: "DELETE" });
      setFlash("Đã xoá toàn bộ phân công.");
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Xoá phân công thất bại.");
    }
  };

  const reopenCase = async (caseId) => {
    try {
      await api(`/api/cases/${caseId}/reopen`, { method: "POST" });
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Mở lại thất bại.");
    }
  };

  const deleteCaseSubmissions = async (caseId) => {
    try {
      const res = await api(`/api/cases/${caseId}/submissions`, { method: "DELETE" });
      setFlash(`Đã xoá ${res.deleted} bài gửi của case ${caseId} (case đã mở lại).`);
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Xoá bài gửi thất bại.");
    }
  };

  const autoAssign = async () => {
    try {
      const res = await api("/api/cases/auto-assign", { method: "POST" });
      setFlash(`Đã phân công thêm ${res.assigned} annotator. Bấm lại để thêm lượt tiếp theo.`);
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Phân công thất bại.");
    }
  };

  const createAnnotator = async (name, passcode) => {
    const a = await api("/api/annotators", { method: "POST", body: { name, passcode } });
    loadAdminData();
    return a;
  };

  const resetPasscode = async (annotatorId, newPasscode) => {
    try {
      const a = await api(`/api/annotators/${annotatorId}`, { method: "PUT", body: { passcode: newPasscode } });
      setFlash(`Mã mới của ${a.name}: ${a.passcode} — hãy gửi cho luật sư.`);
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Đổi mã thất bại.");
    }
  };

  const deleteAnnotator = async (annotatorId) => {
    try {
      await api(`/api/annotators/${annotatorId}`, { method: "DELETE" });
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Xoá thất bại.");
    }
  };

  const createAdmin = async (username, password, name) => {
    const a = await api("/api/admins", { method: "POST", body: { username, password, name } });
    loadAdminData();
    return a;
  };

  const resetAdminPassword = async (username, newPassword) => {
    try {
      await api(`/api/admins/${username}`, { method: "PUT", body: { password: newPassword } });
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Đổi mật khẩu thất bại.");
    }
  };

  const deleteAdmin = async (username) => {
    try {
      await api(`/api/admins/${username}`, { method: "DELETE" });
      loadAdminData();
    } catch (e) {
      setFlash(e.message || "Xoá admin thất bại.");
    }
  };

  const importCorpus = async (cases) => {
    try {
      const res = await api("/api/cases", { method: "POST", body: { cases } });
      setImportMessage(`Đã import ${res.imported} case (tổng ${res.total_cases}).`);
      loadAdminData();
      return true;
    } catch (e) {
      setImportMessage(`Import thất bại: ${e.message}`);
      return false;
    }
  };

  const importFromFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const imported = normalizeCasesPayload(JSON.parse(text));
      await importCorpus(imported);
    } catch (err) {
      setImportMessage(`Không đọc được file: ${err.message}`);
    }
  };

  const importPrototype = async () => {
    await importCorpus(INITIAL_CASES);
  };

  const downloadBlob = (text, filename, type) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* Tải submission phục vụ nghiên cứu: JSON (đầy đủ) hoặc CSV (tóm tắt) */
  const exportSubmissions = async (format = "json") => {
    if (!auth) return;
    try {
      const suffix = format === "csv" ? ".csv" : "";
      const res = await fetch(`${API_BASE}/api/export/submissions${suffix}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).detail || ""; } catch { /* ignore */ }
        throw new Error(detail || `Lỗi ${res.status}`);
      }
      const text = await res.text();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      if (format === "csv") {
        downloadBlob(text, `submissions_summary_${stamp}.csv`, "text/csv;charset=utf-8");
      } else {
        downloadBlob(text, `submissions_${stamp}.json`, "application/json");
      }
      setFlash(`Đã tải ${format === "csv" ? "summary CSV" : "submissions JSON"} (${(text.length / 1024).toFixed(1)} KB).`);
    } catch (e) {
      setFlash(e.message || "Tải dữ liệu thất bại.");
    }
  };

  /* -------------------- derived values -------------------- */

  const allTrackedUnits = useMemo(
    () => caseData ? [...caseData.units, ...caseData.reasoning, ...caseData.decisions] : [],
    [caseData]
  );
  const confirmedCount = allTrackedUnits.filter((u) => u.status === "confirmed").length;
  const totalCount = allTrackedUnits.length;

  const sortedUnits = useMemo(
    () => caseData ? [...caseData.units].sort((a, b) => a.order - b.order) : [],
    [caseData]
  );

  const onDividerDown = () => { draggingRef.current = true; };
  const onMouseMove = (e) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(75, Math.max(28, pct));
    setLeftWidth(pct);
  };
  const onMouseUp = () => { draggingRef.current = false; };

  const TABS = caseData ? [
    { key: "claims", label: "Claims", count: caseData.units.filter((u) => u.type !== "request").length, icon: ListChecks },
    { key: "requests", label: "Requests", count: caseData.units.filter((u) => u.type === "request").length, icon: ClipboardList },
    { key: "reasoning", label: "Reasoning", count: caseData.reasoning.length, icon: Scale },
    { key: "decisions", label: "Decisions", count: caseData.decisions.length, icon: Gavel },
    { key: "links", label: "Links", count: caseData.units.filter((u) => u.type === "request" && ((u.linkedDecisions?.length || 0) + (u.linkedReasoning?.length || 0) > 0)).length, icon: Link2 },
  ] : [];

  const identityChip = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, border: `1px solid ${T.lineStrong}`, background: T.paperDim, fontSize: 12, fontWeight: 600 }}>
      {auth?.type === "admin" ? <Shield size={12} color={T.gold} /> : <UserRound size={12} />}
      {auth?.name}
      <span style={{ color: T.inkSoft, fontWeight: 500 }}>· {auth?.id}</span>
    </span>
  );

  /* -------------------- screens -------------------- */

  if (!auth) {
    return <LoginScreen onLogin={handleLogin} offline={!backendOk} />;
  }

  if (view === "annotation" && caseData) {
    return (
      <div
        onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
        style={{
          width: "100%", height: "100vh", display: "flex", flexDirection: "column",
          fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
          background: T.paper, color: T.ink, overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.line}`, background: T.paperCard }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <IconBtn size={26} title="Về danh sách" onClick={backToDashboard}><LayoutDashboard size={15} /></IconBtn>
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: "Georgia, serif", fontSize: 16, fontWeight: 700 }}>Case {caseData.id}</span>
                  {editingTitle ? (
                    <input
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={commitTitle}
                      onKeyDown={(e) => { if (e.key === "Enter") commitTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                      style={{ ...inputStyle, width: 260, padding: "4px 7px", fontSize: 12 }}
                    />
                  ) : (
                    <>
                      <span style={{ fontSize: 12, color: T.inkSoft }}>{caseData.title}</span>
                      <IconBtn size={23} title="Sửa tên case" onClick={() => { setTitleDraft(caseData.title || `Case ${caseData.id}`); setEditingTitle(true); }}>
                        <Pencil size={12} />
                      </IconBtn>
                    </>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {(caseData.parties || []).map((p) => <PartyTag key={p.id} id={p.id} parties={caseData.parties || []} size="sm" />)}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 110, height: 6, background: T.paperDim, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${totalCount ? (confirmedCount / totalCount) * 100 : 0}%`, height: "100%", background: T.gold }} />
                </div>
                <span style={{ fontSize: 12, color: T.inkSoft, fontWeight: 600 }}>{confirmedCount}/{totalCount} đã xác nhận</span>
              </div>

              {auth?.type === "annotator" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: T.inkSoft }}>
                  {draftStatus === "saving" && <><Loader2 size={13} className="spin" /> Đang lưu nháp…</>}
                  {draftStatus === "saved" && <><CircleCheck size={13} color="#3D6944" /> Đã lưu nháp</>}
                  {draftStatus === "error" && <span style={{ color: T.danger }}>Lỗi lưu nháp</span>}
                  {draftStatus === "idle" && draftLoadedAt && <><FolderOpen size={13} color={T.gold} /> Tiếp tục từ nháp</>}
                </div>
              )}

              {identityChip}
              <IconBtn title="Đăng xuất" onClick={handleLogout}><LogOut size={14} /></IconBtn>
              <IconBtn title="Hướng dẫn" tone={helpOpen ? "gold" : "default"} onClick={() => setHelpOpen((v) => !v)}><CircleHelp size={15} /></IconBtn>

              <button onClick={submitCase} disabled={submitting} style={btnPrimaryStyle}>
                {submitting ? "Đang gửi…" : submitted ? "Cập nhật bài nộp" : "Hoàn tất case"}
              </button>
            </div>
          </div>
          {submitError && <div style={{ marginTop: 8, fontSize: 11.5, color: T.danger }}>{submitError}</div>}
          {submitMessage && <div style={{ marginTop: 8, fontSize: 11.5, color: "#3D6944" }}>{submitMessage}</div>}
        </div>

        <div
          ref={containerRef}
          style={{
            display: "flex", flex: "1 1 0", minHeight: 0, minWidth: 0, width: "100%",
            position: "relative", overflow: "hidden",
            userSelect: draggingRef.current ? "none" : "auto",
          }}
        >
          {helpOpen && <HelpPanel tab={tab} onClose={() => setHelpOpen(false)} />}
          <div style={{ width: `${leftWidth}%`, overflowY: "auto", padding: "16px 16px 40px" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${T.line}`, paddingBottom: 2 }}>
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.key;
                return (
                  <button
                    key={t.key} onClick={() => setTab(t.key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, padding: "7px 11px",
                      fontSize: 12.5, fontWeight: 600, border: "none", cursor: "pointer",
                      background: "transparent", color: active ? T.ink : T.inkSoft,
                      borderBottom: active ? `2px solid ${T.gold}` : "2px solid transparent",
                      borderRadius: 0,
                    }}
                  >
                    <Icon size={14} />
                    {t.label}
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, background: active ? T.goldTint : T.paperDim,
                      color: active ? T.gold : T.inkSoft, padding: "1px 6px", borderRadius: 10,
                    }}>{t.count}</span>
                  </button>
                );
              })}
            </div>

            {tab === "claims" && (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => setAddingType("claim")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}><Plus size={13} /> Thêm claim</button>
                </div>
                {sortedUnits.filter((u) => u.type !== "request").length === 0 && !addingType && (
                  <p style={{ fontSize: 12.5, color: T.inkSoft, background: T.paperDim, borderRadius: 8, padding: "10px 12px", lineHeight: 1.55, margin: "0 0 12px" }}>
                    Chưa có Claim. Bấm <strong>'Thêm claim'</strong> và trích tình tiết, sự kiện từ bản án ở khung bên phải.
                  </p>
                )}
                {addingType === "claim" && (
                  <UnitForm parties={caseData.parties || []} initial={{ type: "claim", order: nextOrder(caseData.units) }} onSave={saveNewUnit} onCancel={() => setAddingType(null)} />
                )}
                {sortedUnits.filter((u) => u.type !== "request").map((u) => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    parties={caseData.parties || []}
                    editing={editingId === u.id}
                    modificationEditing={modificationEditId === u.id}
                    onConfirm={() => toggleConfirm(u.id, "units")}
                    onEditStart={() => setEditingId(u.id)}
                    onEditSave={(data) => saveEditUnit(u.id, data)}
                    onEditCancel={() => setEditingId(null)}
                    onDelete={() => deleteUnit(u.id)}
                    onModificationToggle={() => toggleModifications(u.id)}
                    onAddModification={(m) => addModification(u.id, m)}
                    onUpdateModification={(m, updated) => updateModification(u.id, m, updated)}
                    onRemoveModification={(m) => removeModification(u.id, m)}
                  />
                ))}
              </div>
            )}

            {tab === "requests" && (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => setAddingType("request")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}><Plus size={13} /> Thêm request</button>
                </div>
                {sortedUnits.filter((u) => u.type === "request").length === 0 && !addingType && (
                  <p style={{ fontSize: 12.5, color: T.inkSoft, background: T.paperDim, borderRadius: 8, padding: "10px 12px", lineHeight: 1.55, margin: "0 0 12px" }}>
                    Chưa có Request. Bấm <strong>'Thêm request'</strong> và nhập yêu cầu khởi kiện của đương sự.
                  </p>
                )}
                {addingType === "request" && (
                  <UnitForm parties={caseData.parties || []} initial={{ type: "request", order: nextOrder(caseData.units) }} onSave={saveNewUnit} onCancel={() => setAddingType(null)} />
                )}
                {sortedUnits.filter((u) => u.type === "request").map((u) => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    parties={caseData.parties || []}
                    editing={editingId === u.id}
                    modificationEditing={modificationEditId === u.id}
                    onConfirm={() => toggleConfirm(u.id, "units")}
                    onEditStart={() => setEditingId(u.id)}
                    onEditSave={(data) => saveEditUnit(u.id, data)}
                    onEditCancel={() => setEditingId(null)}
                    onDelete={() => deleteUnit(u.id)}
                    onModificationToggle={() => toggleModifications(u.id)}
                    onAddModification={(m) => addModification(u.id, m)}
                    onUpdateModification={(m, updated) => updateModification(u.id, m, updated)}
                    onRemoveModification={(m) => removeModification(u.id, m)}
                  />
                ))}
              </div>
            )}

            {tab === "reasoning" && (
              <div>
                <button onClick={() => setAddingType("reasoning")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 12 }}><Plus size={13} /> Thêm reasoning</button>
                {(caseData.reasoning || []).length === 0 && !addingType && (
                  <p style={{ fontSize: 12.5, color: T.inkSoft, background: T.paperDim, borderRadius: 8, padding: "10px 12px", lineHeight: 1.55, margin: "0 0 12px" }}>
                    Chưa có Reasoning. Bấm <strong>'Thêm reasoning'</strong> và nhập nhận định, lập luận của Toà án.
                  </p>
                )}
                {addingType === "reasoning" && (
                  <ReasonDecisionForm kind="reasoning" initial={{ order: nextOrder(caseData.reasoning || []) }} onSave={(d) => saveNewSimple("reasoning", d)} onCancel={() => setAddingType(null)} />
                )}
                {[...(caseData.reasoning || [])].sort((a, b) => a.order - b.order).map((r) => (
                  <SimpleCard key={r.id} item={r} kind="reasoning"
                    editing={editingId === r.id}
                    onConfirm={() => toggleConfirm(r.id, "reasoning")}
                    onEditStart={() => setEditingId(r.id)}
                    onEditSave={(d) => saveEditSimple("reasoning", r.id, d)}
                    onEditCancel={() => setEditingId(null)}
                    onDelete={() => deleteSimple("reasoning", r.id)}
                  />
                ))}
              </div>
            )}

            {tab === "decisions" && (
              <div>
                <button onClick={() => setAddingType("decision")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 12 }}><Plus size={13} /> Thêm decision</button>
                {(caseData.decisions || []).length === 0 && !addingType && (
                  <p style={{ fontSize: 12.5, color: T.inkSoft, background: T.paperDim, borderRadius: 8, padding: "10px 12px", lineHeight: 1.55, margin: "0 0 12px" }}>
                    Chưa có Decision. Bấm <strong>'Thêm decision'</strong> và nhập quyết định cuối cùng của Toà án.
                  </p>
                )}
                {addingType === "decision" && (
                  <ReasonDecisionForm kind="decision" initial={{ order: nextOrder(caseData.decisions || []) }} onSave={(d) => saveNewSimple("decisions", d)} onCancel={() => setAddingType(null)} />
                )}
                {[...(caseData.decisions || [])].sort((a, b) => a.order - b.order).map((d) => (
                  <SimpleCard key={d.id} item={d} kind="decision"
                    editing={editingId === d.id}
                    onConfirm={() => toggleConfirm(d.id, "decisions")}
                    onEditStart={() => setEditingId(d.id)}
                    onEditSave={(data) => saveEditSimple("decisions", d.id, data)}
                    onEditCancel={() => setEditingId(null)}
                    onDelete={() => deleteSimple("decisions", d.id)}
                  />
                ))}
              </div>
            )}

            {tab === "links" && <LinksTab caseData={caseData} updateCase={updateCase} />}
          </div>

          <div
            onMouseDown={onDividerDown}
            style={{
              width: 8, cursor: "col-resize", background: T.paperDim, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderLeft: `1px solid ${T.line}`, borderRight: `1px solid ${T.line}`,
            }}
          >
            <GripVertical size={13} color={T.lineStrong} />
          </div>

          <div style={{ flex: `0 0 ${100 - leftWidth}%`, minWidth: 0, minHeight: 0, height: "100%", overflow: "hidden" }}>
            <DocumentPanel caseData={caseData} />
          </div>
        </div>
        {showOnboarding && <OnboardingModal onClose={closeOnboarding} />}
      </div>
    );
  }

  /* dashboard */
  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif", background: T.paper, color: T.ink, overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.line}`, background: T.paperCard, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: T.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Gavel size={15} />
          </div>
          <span style={{ fontFamily: "Georgia, serif", fontSize: 16, fontWeight: 700 }}>Legal Annotation</span>
          {!backendOk && <span style={{ fontSize: 11.5, color: T.danger, background: "#F6E4E0", padding: "2px 8px", borderRadius: 20 }}>Không kết nối được backend</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {identityChip}
          <IconBtn title="Đăng xuất" onClick={handleLogout}><LogOut size={14} /></IconBtn>
        </div>
      </div>
      {auth?.type === "admin" ? (
        <AdminDashboard
          overview={adminOverview}
          annotators={adminAnnotators}
          admins={adminAdmins}
          progress={adminProgress}
          currentUsername={auth?.id}
          onOpenCase={openCase}
          onAssign={assignCase}
          onReopen={reopenCase}
          onDeleteSubmissions={deleteCaseSubmissions}
          onAutoAssign={autoAssign}
          onClearAssignments={clearAllAssignments}
          onImportFile={importFromFile}
          onImportPrototype={importPrototype}
          importMessage={importMessage}
          onExport={exportSubmissions}
          onCreateAnnotator={createAnnotator}
          onResetPasscode={resetPasscode}
          onDeleteAnnotator={deleteAnnotator}
          onCreateAdmin={createAdmin}
          onResetAdminPassword={resetAdminPassword}
          onDeleteAdmin={deleteAdmin}
          onRefresh={refresh}
          refreshing={refreshing}
          flash={flash}
        />
      ) : (
        <AnnotatorDashboard
          cases={myCases}
          stats={myStats}
          onOpen={openCase}
          onRefresh={refresh}
          refreshing={refreshing}
          flash={flash}
          onShowGuide={() => setShowOnboarding(true)}
        />
      )}
      {showOnboarding && <OnboardingModal onClose={closeOnboarding} />}
    </div>
  );
}
