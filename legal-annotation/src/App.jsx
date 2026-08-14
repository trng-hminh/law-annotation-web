import React, { useState, useRef, useMemo, useCallback } from "react";
import rawPrototypeCases from "./prototype_10_cases.json";
import {
  ChevronLeft, ChevronRight, Check, Plus, Pencil, Trash2, Link2,
  ZoomIn, ZoomOut, X, GripVertical, ScrollText, Gavel, ListChecks,
  Scale, CircleCheck, Circle, ChevronDown, Upload, CheckCircle2
} from "lucide-react";

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
                  onChange={(e) => onUpdate(i, { ...m, text: e.target.value })}
                  style={{ width: "100%", minHeight: 55, resize: "vertical", border: `1px solid ${T.line}`, borderRadius: 5, padding: 7, font: "inherit", fontSize: 12.5, lineHeight: 1.5, boxSizing: "border-box" }}
                />
              </div>
              <IconBtn tone="danger" size={24} onClick={() => onRemove(i)} title="Xoá yêu cầu sửa đổi">
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

function DocumentPanel({ caseData }) {
  const [page, setPage] = useState(2);
  const [zoom, setZoom] = useState(100);
  const maxPage = caseData.totalPages;

  const content = caseData.pages[page] || "(Trang này chưa có nội dung số hoá)";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: T.paperDim }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 14px", borderBottom: `1px solid ${T.line}`, background: T.paperCard, flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ScrollText size={15} color={T.inkSoft} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{caseData.sourceFile}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <IconBtn size={24} onClick={() => setZoom((z) => Math.max(60, z - 10))} title="Thu nhỏ"><ZoomOut size={14} /></IconBtn>
          <span style={{ fontSize: 11.5, color: T.inkSoft, width: 36, textAlign: "center" }}>{zoom}%</span>
          <IconBtn size={24} onClick={() => setZoom((z) => Math.min(180, z + 10))} title="Phóng to"><ZoomIn size={14} /></IconBtn>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconBtn size={24} onClick={() => setPage((p) => Math.max(1, p - 1))} title="Trang trước"><ChevronLeft size={15} /></IconBtn>
          <span style={{ fontSize: 12, color: T.inkSoft }}>Trang {page} / {maxPage}</span>
          <IconBtn size={24} onClick={() => setPage((p) => Math.min(maxPage, p + 1))} title="Trang sau"><ChevronRight size={15} /></IconBtn>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px", display: "flex", justifyContent: "center" }}>
        <div style={{
          width: `${zoom}%`, maxWidth: 640, minWidth: 280, background: "#fff",
          boxShadow: "0 1px 3px rgba(28,38,36,0.12), 0 1px 1px rgba(28,38,36,0.08)",
          borderRadius: 2, padding: "34px 30px", fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 13.5, lineHeight: 1.85, color: "#22201A", whiteSpace: "pre-wrap",
          minHeight: 780,
        }}>
          {content}
          <div style={{ textAlign: "center", marginTop: 24, fontSize: 11, color: "#948C74" }}>— {page} —</div>
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
    assertedBy: (r.requested_by || []).map(String),
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

/* ---------------------------- main app ---------------------------- */

export default function LegalAnnotationApp() {
  const [cases, setCases] = useState(INITIAL_CASES);
  const [caseIdx, setCaseIdx] = useState(0);
  const [tab, setTab] = useState("units");
  const [leftWidth, setLeftWidth] = useState(50);
  const draggingRef = useRef(false);
  const containerRef = useRef(null);

  const [addingType, setAddingType] = useState(null); // 'claim' | 'request' | 'reasoning' | 'decision' | null
  const [editingId, setEditingId] = useState(null);
  const [modificationEditId, setModificationEditId] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const importRef = useRef(null);

  const caseData = cases[caseIdx];
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");

const submitCase = async () => {
  setSubmitting(true);
  setSubmitError("");

  try {
    const payload = {
      case_id: caseData.id,
      title: caseData.title,

      parties: caseData.parties,

      units: caseData.units,

      reasoning: caseData.reasoning,

      decisions: caseData.decisions,

      submitted_at: new Date().toISOString(),
    };

    const response = await fetch(
      "http://localhost:8000/api/submit",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      throw new Error("Submit failed");
    }

    const result = await response.json();

    console.log("Submitted:", result);

    setSubmitted(true);

  } catch (error) {

    console.error(error);

    setSubmitError(
      "Không thể gửi kết quả. Vui lòng thử lại."
    );

  } finally {

    setSubmitting(false);
  }
};


  const updateCase = useCallback((fn) => {
    setCases((cs) => cs.map((c, i) => (i === caseIdx ? fn(c) : c)));
  }, [caseIdx]);

  const allTrackedUnits = useMemo(
    () => [...caseData.units, ...caseData.reasoning, ...caseData.decisions],
    [caseData]
  );
  const confirmedCount = allTrackedUnits.filter((u) => u.status === "confirmed").length;
  const totalCount = allTrackedUnits.length;

  const sortedUnits = useMemo(
    () => [...caseData.units].sort((a, b) => a.order - b.order),
    [caseData.units]
  );

  /* --- drag handle --- */
  const onDividerDown = () => { draggingRef.current = true; };
  const onMouseMove = (e) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(75, Math.max(28, pct));
    setLeftWidth(pct);
  };
  const onMouseUp = () => { draggingRef.current = false; };

  /* --- unit CRUD --- */
  const toggleConfirm = (id, group) => {
    updateCase((c) => {
      const key = group;
      return {
        ...c,
        [key]: c[key].map((u) => u.id === id ? { ...u, status: u.status === "confirmed" ? "unconfirmed" : "confirmed" } : u),
      };
    });
  };

  const saveNewUnit = (data) => {
    const prefix = data.type === "claim" ? "C" : "R";
    const existingIds = caseData.units.filter((u) => u.id.startsWith(prefix)).map((u) => parseInt(u.id.slice(1)) || 0);
    const nextNum = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const newUnit = { id: `${prefix}${nextNum}`, status: "unconfirmed", modification_spans: [], ...data };
    if (data.type === "request") { newUnit.outcome = null; newUnit.linkedDecisions = []; newUnit.linkedReasoning = []; newUnit.linksConfirmed = false; }
    updateCase((c) => ({ ...c, units: [...c.units, newUnit] }));
    setAddingType(null);
  };

  const saveEditUnit = (id, data) => {
    updateCase((c) => ({ ...c, units: c.units.map((u) => (u.id === id ? { ...u, ...data } : u)) }));
    setEditingId(null);
  };

  const deleteUnit = (id) => {
    updateCase((c) => ({ ...c, units: c.units.filter((u) => u.id !== id) }));
  };

  const toggleModifications = (unitId) => {
    setModificationEditId((id) => id === unitId ? null : unitId);
  };

  const addModification = (unitId, modification) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => u.id === unitId
        ? { ...u, modification_spans: [...(u.modification_spans || []), modification] }
        : u),
    }));
  };

  const updateModification = (unitId, idx, modification) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => {
        if (u.id !== unitId) return u;
        const list = [...(u.modification_spans || [])];
        list[idx] = modification;
        return { ...u, modification_spans: list };
      }),
    }));
  };

  const removeModification = (unitId, idx) => {
    updateCase((c) => ({
      ...c,
      units: c.units.map((u) => u.id === unitId
        ? { ...u, modification_spans: (u.modification_spans || []).filter((_, i) => i !== idx) }
        : u),
    }));
  };

  const commitTitle = () => {
    const title = titleDraft.trim();
    if (title) updateCase((c) => ({ ...c, title }));
    setEditingTitle(false);
  };

  const importCases = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const imported = normalizeCasesPayload(JSON.parse(text));
      setCases(imported);
      setCaseIdx(0);
      setTab("units");
      setEditingId(null);
      setModificationEditId(null);
      setImportMessage(`Đã nạp ${imported.length} case.`);
    } catch (err) {
      setImportMessage(`Không thể nạp dữ liệu: ${err.message}`);
    }
  };

  const saveNewSimple = (kind, data) => {
    const prefix = kind === "reasoning" ? "RE" : "DE";
    const list = caseData[kind];
    const existingIds = list.map((u) => parseInt(u.id.replace(prefix, "")) || 0);
    const nextNum = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const item = { id: `${prefix}${nextNum}`, status: "unconfirmed", ...data };
    updateCase((c) => ({ ...c, [kind]: [...c[kind], item] }));
    setAddingType(null);
  };
  const saveEditSimple = (kind, id, data) => {
    updateCase((c) => ({ ...c, [kind]: c[kind].map((u) => (u.id === id ? { ...u, ...data } : u)) }));
    setEditingId(null);
  };
  const deleteSimple = (kind, id) => {
    updateCase((c) => ({ ...c, [kind]: c[kind].filter((u) => u.id !== id) }));
  };

  const TABS = [
    { key: "units", label: "Claims & Requests", count: caseData.units.length, icon: ListChecks },
    { key: "reasoning", label: "Reasoning", count: caseData.reasoning.length, icon: Scale },
    { key: "decisions", label: "Decisions", count: caseData.decisions.length, icon: Gavel },
    { key: "links", label: "Links", count: caseData.units.filter(u => u.type === "request" && ((u.linkedDecisions?.length||0)+(u.linkedReasoning?.length||0) > 0)).length, icon: Link2 },
  ];

  return (
    <div
      onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
      style={{
        width: "100%",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
        background: T.paper,
        color: T.ink,
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.line}`, background: T.paperCard }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <IconBtn size={26} title="Case trước" onClick={() => setCaseIdx((i) => Math.max(0, i - 1))}><ChevronLeft size={16} /></IconBtn>
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
                {caseData.parties.map((p) => <PartyTag key={p.id} id={p.id} parties={caseData.parties} size="sm" />)}
              </div>
            </div>
            <IconBtn size={26} title="Case sau" onClick={() => setCaseIdx((i) => Math.min(cases.length - 1, i + 1))}><ChevronRight size={16} /></IconBtn>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 110, height: 6, background: T.paperDim, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${totalCount ? (confirmedCount/totalCount)*100 : 0}%`, height: "100%", background: T.gold, transition: "width 200ms ease" }} />
              </div>
              <span style={{ fontSize: 12, color: T.inkSoft, fontWeight: 600 }}>{confirmedCount}/{totalCount} đã xác nhận</span>
            </div>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => { importCases(e.target.files?.[0]); e.target.value = ""; }}
            />
            <button
              onClick={() => importRef.current?.click()}
              style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}
              title="Nhập một hoặc nhiều case từ JSON"
            >
              <Upload size={13} /> Nhập JSON
            </button>
            <button
              onClick={submitCase}
              disabled={submitting || submitted}
              style={btnPrimaryStyle}
            >
              {submitting
                ? "Đang gửi..."
                : submitted
                  ? "Đã gửi ✓"
                  : "Hoàn tất case"}
            </button>
          </div>
        </div>
        {importMessage && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: importMessage.startsWith("Không") ? T.danger : "#3D6944" }}>
            {importMessage}
          </div>
        )}
      </div>

      {/* split body */}
      <div
        ref={containerRef}
        style={{
          display: "flex",
          flex: "1 1 0",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          position: "relative",
          overflow: "hidden",
          userSelect: draggingRef.current ? "none" : "auto",
        }}
      >
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

          {tab === "units" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button onClick={() => setAddingType("claim")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}><Plus size={13} /> Thêm claim</button>
                <button onClick={() => setAddingType("request")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5 }}><Plus size={13} /> Thêm request</button>
              </div>
              {addingType === "claim" && (
                <UnitForm parties={caseData.parties} initial={{ type: "claim", order: sortedUnits.length + 1 }} onSave={saveNewUnit} onCancel={() => setAddingType(null)} />
              )}
              {addingType === "request" && (
                <UnitForm parties={caseData.parties} initial={{ type: "request", order: sortedUnits.length + 1 }} onSave={saveNewUnit} onCancel={() => setAddingType(null)} />
              )}
              {sortedUnits.map((u) => (
                <UnitCard
                  key={u.id}
                  unit={u}
                  parties={caseData.parties}
                  editing={editingId === u.id}
                  modificationEditing={modificationEditId === u.id}
                  onConfirm={() => toggleConfirm(u.id, "units")}
                  onEditStart={() => setEditingId(u.id)}
                  onEditSave={(data) => saveEditUnit(u.id, data)}
                  onEditCancel={() => setEditingId(null)}
                  onDelete={() => deleteUnit(u.id)}
                  onModificationToggle={() => toggleModifications(u.id)}
                  onAddModification={(m) => addModification(u.id, m)}
                  onUpdateModification={(idx, m) => updateModification(u.id, idx, m)}
                  onRemoveModification={(idx) => removeModification(u.id, idx)}
                />
              ))}
            </div>
          )}

          {tab === "reasoning" && (
            <div>
              <button onClick={() => setAddingType("reasoning")} style={{ ...btnGhostStyle, display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 12 }}><Plus size={13} /> Thêm reasoning</button>
              {addingType === "reasoning" && (
                <ReasonDecisionForm kind="reasoning" initial={{ order: caseData.reasoning.length + 1 }} onSave={(d) => saveNewSimple("reasoning", d)} onCancel={() => setAddingType(null)} />
              )}
              {[...caseData.reasoning].sort((a,b)=>a.order-b.order).map((r) => (
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
              {addingType === "decision" && (
                <ReasonDecisionForm kind="decision" initial={{ order: caseData.decisions.length + 1 }} onSave={(d) => saveNewSimple("decisions", d)} onCancel={() => setAddingType(null)} />
              )}
              {[...caseData.decisions].sort((a,b)=>a.order-b.order).map((d) => (
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

        {/* divider */}
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

        <div
        style={{
            flex: `0 0 ${100 - leftWidth}%`,
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
        <DocumentPanel caseData={caseData} />
      </div>
      </div>
    </div>
  );
}
