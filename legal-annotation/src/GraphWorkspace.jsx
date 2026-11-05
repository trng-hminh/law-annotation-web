import { useEffect, useRef } from 'react';
import { addGraphUnit, attachUnit, classifyUnit, supportLabels } from './annotationGraph.js';
import { actorIds } from './parties.js';

const labels = { request: 'yêu cầu', opinion: 'ý kiến', premise: 'luận cứ' };
const box = { padding: 12, margin: '10px 0', border: '1px solid #D8D6CB', borderRadius: 9, background: '#fffdf7', minWidth: 0 };
const button = { padding: '7px 10px', margin: '3px 5px 3px 0', border: '1px solid #BBB9AF', borderRadius: 6, background: 'white', cursor: 'pointer', color: '#263C38' };
const input = { width: '100%', boxSizing: 'border-box', padding: 8, margin: '6px 0', border: '1px solid #BBB9AF', borderRadius: 6 };

export default function GraphWorkspace({ doc, tab, updateCase, UnitForm, UnitCard, beginEditor, closeEditor, stageForm, saveNewUnit, saveEditUnit, deleteUnit, toggleConfirm, addingType, editingId, editorState, busyError }) {
  const picker = editorState.picker;
  const kind = { requests: 'request', opinions: 'opinion', premises: 'premise' }[tab];
  const sorted = [...doc.units].sort((a, b) => (a.order || 0) - (b.order || 0));
  const editing = doc.units.find((u) => u.id === editingId);
  const graphEditing = editing && ['request', 'opinion', 'premise', 'claim'].includes(editing.type);
  const activePanel = useRef(null);
  useEffect(() => { activePanel.current?.scrollIntoView({ block: 'nearest' }); }, [picker?.parentId, picker?.type, editingId, addingType]);
  const stagePicker = (patch, { markDirty = false } = {}) =>
    updateCase((c) => ({ ...c, _editor_state: { ...c._editor_state, picker: { ...c._editor_state?.picker, ...patch } } }), { markDirty });
  const openPicker = (parent, type) => {
    if (addingType || editingId || picker) { busyError(); return; }
    stagePicker({ parentId: parent.id, type, actorFilter: type === 'premise' ? actorIds(parent) : [], query: '', creating: false, form: null });
  };
  const classify = (unit, type) => {
    if (addingType || editingId || picker) { busyError(); return; }
    updateCase((c) => classifyUnit(c, unit.id, type));
  };
  const renderCard = (u) => <UnitCard unit={u} parties={doc.parties} editing={false}
    onConfirm={() => toggleConfirm(u.id, 'units')} onEditStart={() => beginEditor(u.type, u)} onDelete={() => deleteUnit(u.id)} />;
  const renderPremises = (parent) => <section style={{ ...box, background: '#F4F5F0' }} aria-label={`Luận cứ của ${parent.id}`}>
    <strong>Luận cứ hỗ trợ ({parent.premise_ids?.length || 0})</strong>{' '}
    <button style={button} onClick={() => openPicker(parent, 'premise')}>Chọn / thêm luận cứ cho {parent.id}</button>
    {(parent.premise_ids || []).map((id) => {
      const p = doc.units.find((u) => u.type === 'premise' && u.id === id);
      return p ? <details key={id} style={{ marginTop: 8 }}><summary>{id} · {p.text.slice(0, 90)}{p.text.length > 90 ? '…' : ''}</summary>{renderCard(p)}</details> : <p key={id} role="alert">Không tìm thấy {id}; mở hộp chọn để gỡ liên kết.</p>;
    })}
  </section>;
  const opinionParents = (id) => doc.units.filter((r) => r.type === 'request' && r.opinion_ids?.includes(id)).map((r) => r.id).join(', ') || 'Chưa gắn Request';
  const renderOpinion = (o) => <div>{renderCard(o)}<p style={{ fontSize: 12 }}>Đang gắn với: {opinionParents(o.id)} · Chỉ đọc (gắn/gỡ tại Requests)</p>
    {o.legacy_source?.type === 'request' && <details style={box}>
      <summary>Đối chiếu Request cũ {o.legacy_source.id} (chỉ đọc)</summary>
      <p>Reasoning cũ: {(o.legacy_source.linkedReasoning || []).join(', ') || '—'}</p>
      <p>Decision cũ: {(o.legacy_source.linkedDecisions || []).join(', ') || '—'}</p>
      <p>Outcome cũ: {o.legacy_source.outcome || '—'}</p>
      <p>Gắn Opinion vào Request phù hợp tại Requests, rồi kiểm tra lại Reasoning/Decision/Outcome tại Links. Thông tin cũ này chỉ dùng đối chiếu, không phải liên kết đang hoạt động.</p>
    </details>}{renderPremises(o)}</div>;
  const parent = picker && doc.units.find((u) => u.id === picker.parentId);
  const selectedKey = picker?.type === 'opinion' ? 'opinion_ids' : 'premise_ids';
  const selected = parent?.[selectedKey] || [];
  const filtered = picker ? sorted.filter((u) => u.type === picker.type && (selected.includes(u.id) || (
    (!picker.actorFilter?.length || actorIds(u).some((id) => picker.actorFilter.includes(id))) &&
    `${u.id} ${u.text}`.toLocaleLowerCase().includes((picker.query || '').toLocaleLowerCase())
  ))) : [];

  return <div>
    {sorted.some((u) => u.type === 'claim' || u.needs_classification) && <section style={{ ...box, background: '#FFF4D8' }} aria-label="Rà soát dữ liệu cũ">
      <strong>Rà soát dữ liệu cũ</strong>
      <p>Không tự suy đoán loại nội dung. Phân loại Claims thành Opinion hoặc Premise; kiểm tra Requests có thực sự là yêu cầu. Nội dung nguyên văn và nguồn cũ được giữ lại.</p>
      {sorted.filter((u) => u.type === 'claim' || u.needs_classification).map((u) => <details key={u.id}>
        <summary>{u.id} · {u.type === 'claim' ? 'Claim cần phân loại' : 'Request cần rà soát'}</summary>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{u.text}</p>
        {u.type === 'request' && <button style={button} onClick={() => classify(u, 'request')}>Giữ là Request {u.id}</button>}
        <button style={button} onClick={() => classify(u, 'opinion')}>Chuyển {u.id} thành Opinion</button>
        {u.type === 'claim' && <button style={button} onClick={() => classify(u, 'premise')}>Chuyển {u.id} thành Premise</button>}
        {u.type === 'request' && <p>Chuyển thành Opinion sẽ bỏ liên kết Reasoning/Decision/Outcome đang hoạt động của Request này. Bản cũ được giữ ở legacy_source; hãy gắn Opinion vào Request đúng và rà soát Links.</p>}
      </details>)}
    </section>}

    {kind && <button style={button} onClick={() => beginEditor(kind)}>+ Thêm {labels[kind]}</button>}
    {(graphEditing || ['request', 'opinion', 'premise', 'claim'].includes(addingType)) && <div ref={activePanel}><UnitForm key={editingId || addingType}
      initial={{ ...(editing || { type: addingType, order: Math.max(0, ...doc.units.map((u) => u.order || 0)) + 1 }), ...editorState.form }}
      parties={doc.parties} onDraftChange={stageForm} onCancel={closeEditor}
      onSave={(data) => editing ? saveEditUnit(editing.id, data) : saveNewUnit(data)} /></div>}

    {picker && parent && <section ref={activePanel} role="region" aria-label={`Chọn / thêm ${labels[picker.type]} cho ${parent.id}`} style={{ ...box, border: '2px solid #B38A34' }}>
      <h3 style={{ marginTop: 0 }}>Chọn / thêm {labels[picker.type]} cho {parent.id}</h3>
      <label>Người trình bày
        <select aria-label="Lọc người trình bày" style={input} value={picker.actorFilter?.length ? (picker.actorFilter.length === 1 ? picker.actorFilter[0] : '__same__') : ''}
          onChange={(e) => stagePicker({ actorFilter: e.target.value === '__same__' ? actorIds(parent) : e.target.value ? [e.target.value] : [] })}>
          <option value="">Tất cả người trình bày</option>
          {actorIds(parent).length > 1 && <option value="__same__">Cùng người trình bày với {parent.id}</option>}
          {doc.parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
        </select>
      </label>
      <label>Tìm kiếm<input aria-label="Tìm đơn vị để liên kết" style={input} value={picker.query || ''} onChange={(e) => stagePicker({ query: e.target.value })} /></label>
      <p style={{ fontSize: 12 }}>Các mục đã gắn luôn hiển thị để có thể gỡ. Bỏ tick chỉ gỡ liên kết, không xoá nội dung.</p>
      <div style={{ height: 220, overflowY: 'auto', border: '1px solid #D8D6CB', padding: 8 }}>
        {filtered.map((u) => <label key={u.id} style={{ display: 'block', padding: '8px 0', overflowWrap: 'anywhere' }}>
          <input type="checkbox" checked={selected.includes(u.id)} onChange={(e) => updateCase((c) => attachUnit(c, parent.id, picker.type, u.id, e.target.checked))} />
          {' '}{u.id} · {actorIds(u).map((id) => doc.parties.find((p) => p.id === id)?.name || id).join(', ')} · {u.text}
        </label>)}
        {!filtered.length && <p>Không có mục phù hợp. Đổi bộ lọc hoặc tạo mới bên dưới.</p>}
        {selected.filter((id) => !doc.units.some((u) => u.id === id)).map((id) => <button key={id} style={button} onClick={() => updateCase((c) => attachUnit(c, parent.id, picker.type, id, false))}>Gỡ tham chiếu thiếu {id}</button>)}
      </div>
      {picker.creating ? <UnitForm key={`${parent.id}-${picker.type}`} initial={{ type: picker.type, order: Math.max(0, ...doc.units.map((u) => u.order || 0)) + 1,
        assertedBy: picker.type === 'premise' ? actorIds(parent) : [], ...picker.form }} parties={doc.parties}
        saveLabel="Lưu & gắn" onDraftChange={(form) => stagePicker({ form }, { markDirty: true })} onCancel={() => stagePicker({ creating: false, form: null })}
        onSave={(data) => updateCase((c) => ({ ...addGraphUnit(c, data, parent.id), _editor_state: { ...c._editor_state, picker: { ...c._editor_state.picker, creating: false, form: null } } }))} />
        : <><button style={button} onClick={() => stagePicker({ creating: true, form: null })}>+ Tạo {labels[picker.type]} mới</button>
          <button style={button} onClick={() => updateCase((c) => ({ ...c, _editor_state: { ...c._editor_state, picker: null } }), { markDirty: false })}>Xong</button></>}
    </section>}

    {kind && !sorted.some((u) => u.type === kind) && <p>Chưa có {labels[kind]}. Thêm đoạn trích nguyên văn; không tự viết lại luận điểm ngầm.</p>}
    {kind && sorted.filter((u) => u.type === kind).map((u) => <details key={u.id} open style={box}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, overflowWrap: 'anywhere' }}>{u.id} · {u.text.slice(0, 80)}{u.text.length > 80 ? '…' : ''}</summary>
      {kind === 'opinion' ? renderOpinion(u) : renderCard(u)}
      {kind === 'premise' && <p style={{ fontSize: 12 }}>Đang hỗ trợ: {supportLabels(doc, u.id).join('; ') || 'Chưa gắn (vẫn được lưu)'} · Chỉ đọc</p>}
      {kind === 'request' && <>
        <p>Trạng thái yêu cầu: {u.request_status || 'ACTIVE'}</p>
        {!u.needs_classification && <details><summary>Phân loại lại Request này</summary><p>Nếu đây chỉ là ý kiến phản hồi, chuyển sang Opinion. Các liên kết toà án cũ sẽ được lưu trong legacy_source để rà soát.</p><button style={button} onClick={() => classify(u, 'opinion')}>Chuyển {u.id} thành Opinion</button></details>}
        {renderPremises(u)}
        <section style={box}><strong>Ý kiến các bên ({u.opinion_ids?.length || 0})</strong>{' '}
          <button style={button} onClick={() => openPicker(u, 'opinion')}>Chọn / thêm ý kiến cho {u.id}</button>
          {(u.opinion_ids || []).map((id) => {
            const opinion = doc.units.find((o) => o.type === 'opinion' && o.id === id);
            return opinion ? <details key={id} open><summary>{id} · {opinion.text.slice(0, 80)}</summary>{renderOpinion(opinion)}</details> : <p key={id}>Không tìm thấy Opinion {id}.</p>;
          })}
        </section>
      </>}
    </details>)}
  </div>;
}
