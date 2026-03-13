/**
 * flowchart-editor.mjs
 * BPMN-compliant process flowchart editor (React Flow).
 * Exposed as window.FlowchartEditor { mount, unmount } for vanilla JS callers.
 *
 * BPMN shapes
 *   Events     : Start Event · Intermediate Event · End Event  (circles)
 *   Activities : Task · Sub-Process                             (rounded rects)
 *   Gateways   : XOR (×) · AND (+) · OR (○)                   (diamonds)
 *   Artifacts  : Annotation  (bracket with cross-link support)
 *
 * Toolbar sections are individually collapsible.
 * Annotation nodes support linking to any app entity (process, risk, task, …).
 */

import React, {
  useState, useCallback, useEffect, useRef, useMemo, useContext, createContext,
} from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';
import {
  ReactFlow, addEdge, useNodesState, useEdgesState, useReactFlow,
  Controls, Background, Panel, MarkerType, BackgroundVariant,
  Handle, Position, EdgeLabelRenderer, BaseEdge,
  getBezierPath, getSmoothStepPath, getStraightPath,
} from 'https://esm.sh/@xyflow/react@12?deps=react@18,react-dom@18';

const e = React.createElement;
let _seq = 0;
const nextId = () => `n${++_seq}-${Date.now()}`;

// ─── BPMN Node Definitions ───────────────────────────────────────────────────

const NODE_DEF = {
  // Events (circles)
  startEvent:        { label: 'Start',        shape: 'circle',     bg: '#dcfce7', border: '#22c55e', bw: '2px'  },
  intermediateEvent: { label: 'Intermediate', shape: 'dblCircle',  bg: '#dbeafe', border: '#3b82f6', bw: '2px'  },
  endEvent:          { label: 'End',           shape: 'circle',     bg: '#fee2e2', border: '#ef4444', bw: '4px'  },
  // Activities
  task:              { label: 'Task',          shape: 'rect',       bg: '#ffffff', border: '#6b7280'              },
  subProcess:        { label: 'Sub-Process',   shape: 'rect',       bg: '#f0f9ff', border: '#0ea5e9', marker: '⊕'},
  // Gateways
  xorGateway:        { label: '',              shape: 'diamond',    bg: '#fef3c7', border: '#f59e0b', symbol: '×' },
  andGateway:        { label: '',              shape: 'diamond',    bg: '#f3e8ff', border: '#a855f7', symbol: '+' },
  orGateway:         { label: '',              shape: 'diamond',    bg: '#ecfeff', border: '#06b6d4', symbol: '○' },
  // Artifacts
  annotation:        { label: 'Note…',         shape: 'annotation', bg: 'transparent', border: '#9ca3af'          },
  // Legacy (backward compat)
  input:    { label: 'Start',    shape: 'pill', bg: '#d1fae5', border: '#34d399' },
  output:   { label: 'End',      shape: 'pill', bg: '#fee2e2', border: '#f87171' },
  default:  { label: 'Step',     shape: 'rect', bg: '#ffffff', border: '#d1d5db' },
  decision: { label: 'Decision', shape: 'rect', bg: '#fef3c7', border: '#fbbf24', dashed: true },
};

// ─── Link-type metadata (for annotation cross-links) ─────────────────────────

const TYPE_META = {
  process:     { label: 'Process',     icon: '⚙' },
  risk:        { label: 'Risk',        icon: '⚠' },
  task:        { label: 'Task',        icon: '✅' },
  audit:       { label: 'Audit',       icon: '✏' },
  requirement: { label: 'Requirement', icon: '📋' },
  role:        { label: 'Role',        icon: '👤' },
  system:      { label: 'System',      icon: '🖥' },
  asset:       { label: 'Asset',       icon: '📦' },
  document:    { label: 'Document',    icon: '📄' },
  action:      { label: 'Action',      icon: '⚡' },
};
const LINK_TYPES = Object.keys(TYPE_META);

function navigateToItem(type) {
  if (typeof window.switchView !== 'function') return;
  const archTypes = ['role', 'process', 'system', 'asset', 'facility'];
  const viewMap = {
    risk: 'risk-identification', task: 'tasks', audit: 'audit-plan',
    requirement: 'audit-requirements', document: 'document-control', action: 'actions',
  };
  if (archTypes.includes(type)) {
    window.currentArchTab = type;
    window.switchView('architecture');
  } else {
    const view = viewMap[type];
    if (view) window.switchView(view);
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CIRCLE_SIZE   = 62;
const DIAMOND_OUTER = 80;
const DIAMOND_INNER = Math.round(DIAMOND_OUTER / Math.SQRT2);

const HANDLE_SX = {
  width: 9, height: 9,
  background: '#6366f1',
  border: '2px solid #fff',
  borderRadius: '50%',
  zIndex: 10,
};

const ETBTN = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '13px', padding: '2px 5px',
  color: '#374151', borderRadius: '3px', lineHeight: 1.3,
};

const EDGE_TYPES_CYCLE = ['bezier', 'step', 'straight'];
const EDGE_TYPE_ICON   = { bezier: '⌒', step: '⌐', straight: '—' };

// ─── Context (passes openLinkPicker down to annotation nodes) ─────────────────

const FlowCtx = createContext(null);

// ─── Shared handles ───────────────────────────────────────────────────────────

function Handles() {
  return [
    e(Handle, { key: 't', type: 'source', position: Position.Top,    id: 't', style: { ...HANDLE_SX, top:    -5 } }),
    e(Handle, { key: 'r', type: 'source', position: Position.Right,  id: 'r', style: { ...HANDLE_SX, right:  -5 } }),
    e(Handle, { key: 'b', type: 'source', position: Position.Bottom, id: 'b', style: { ...HANDLE_SX, bottom: -5 } }),
    e(Handle, { key: 'l', type: 'source', position: Position.Left,   id: 'l', style: { ...HANDLE_SX, left:   -5 } }),
  ];
}

// ─── Custom Node ──────────────────────────────────────────────────────────────

function FlowNode({ id, data, type, selected }) {
  const { updateNodeData } = useReactFlow();
  const ctx = useContext(FlowCtx);
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(data.label ?? '');
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setDraft(data.label ?? ''); }, [data.label, editing]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const confirm = useCallback(() => {
    setEditing(false);
    updateNodeData(id, { label: draft.trim() });
  }, [draft, id, updateNodeData]);

  const onKeyDown = useCallback((ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); confirm(); }
    if (ev.key === 'Escape') { setDraft(data.label ?? ''); setEditing(false); }
    ev.stopPropagation();
  }, [confirm, data.label]);

  const startEdit = useCallback((ev) => { ev.stopPropagation(); setEditing(true); }, []);

  const def = NODE_DEF[type] ?? NODE_DEF.task;
  const { shape, bg, border, bw = '1.5px', marker, symbol, dashed } = def;

  const inlineInput = (extra = {}) => e('input', {
    ref: inputRef, value: draft,
    onChange: ev => setDraft(ev.target.value),
    onBlur: confirm, onKeyDown,
    style: {
      border: 'none', outline: 'none', background: 'transparent',
      textAlign: 'center', fontSize: 'inherit', fontFamily: 'inherit',
      padding: 0, width: '100%', minWidth: 40, ...extra,
    },
  });

  // ── Circle events ──
  if (shape === 'circle' || shape === 'dblCircle') {
    return e('div', {
      style: {
        width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
        border: `${bw} solid ${border}`, background: bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative', cursor: 'default',
        boxShadow: selected ? '0 0 0 2.5px #6366f1' : undefined,
      },
      onDoubleClick: startEdit,
      title: 'Double-click to rename',
    },
      ...Handles(),
      shape === 'dblCircle' && e('div', {
        style: { position: 'absolute', inset: 5, borderRadius: '50%', border: `2px solid ${border}`, pointerEvents: 'none' },
      }),
      editing
        ? inlineInput({ fontSize: 10, width: '75%' })
        : e('span', {
            style: { fontSize: 10, lineHeight: 1.2, textAlign: 'center', padding: '0 6px', wordBreak: 'break-word' },
          }, data.label ?? ''),
    );
  }

  // ── Diamond gateways ──
  if (shape === 'diamond') {
    const off = (DIAMOND_OUTER - DIAMOND_INNER) / 2;
    return e('div', {
      style: { width: DIAMOND_OUTER, height: DIAMOND_OUTER, position: 'relative', cursor: 'default' },
      onDoubleClick: startEdit,
      title: 'Double-click to add label',
    },
      ...Handles(),
      e('div', {
        style: {
          position: 'absolute', width: DIAMOND_INNER, height: DIAMOND_INNER, top: off, left: off,
          transform: 'rotate(45deg)', background: bg, border: `2px solid ${border}`,
          boxShadow: selected ? '0 0 0 2.5px #6366f1' : undefined,
        },
      }),
      e('div', {
        style: {
          position: 'absolute', top: 0, left: 0, width: DIAMOND_OUTER, height: DIAMOND_OUTER,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          zIndex: 1, pointerEvents: 'none',
        },
      },
        e('span', { style: { fontSize: 22, fontWeight: 700, color: border, lineHeight: 1 } }, symbol ?? ''),
        !editing && data.label && e('span', { style: { fontSize: 9, color: '#374151', marginTop: 1 } }, data.label),
      ),
      editing && e('div', {
        style: { position: 'absolute', top: DIAMOND_OUTER + 3, left: '50%', transform: 'translateX(-50%)', zIndex: 2, pointerEvents: 'all' },
      },
        e('input', {
          ref: inputRef, value: draft, placeholder: 'Label…',
          onChange: ev => setDraft(ev.target.value),
          onBlur: confirm, onKeyDown,
          style: { width: 80, border: '1px solid #9ca3af', borderRadius: 3, outline: 'none', textAlign: 'center', fontSize: 11, padding: '1px 4px' },
        }),
      ),
    );
  }

  // ── Annotation (with cross-links) ──
  if (shape === 'annotation') {
    const links = data.links ?? [];

    const removeLink = (ev, idx) => {
      ev.stopPropagation();
      updateNodeData(id, { links: links.filter((_, i) => i !== idx) });
    };

    return e('div', {
      style: {
        minWidth: 140, maxWidth: 260,
        borderLeft: `3px solid ${border}`,
        borderTop: `1px solid ${border}`,
        borderBottom: `1px solid ${border}`,
        background: '#fffdf0',
        position: 'relative', cursor: 'default',
        boxShadow: selected ? '0 0 0 2px #6366f1' : undefined,
        borderRadius: '0 4px 4px 0',
      },
    },
      ...Handles(),

      // Label row
      e('div', {
        style: { padding: '5px 8px', fontSize: 11, fontStyle: 'italic', color: '#374151' },
        onDoubleClick: startEdit,
        title: 'Double-click to rename',
      },
        editing
          ? inlineInput({ fontStyle: 'italic' })
          : e('span', { style: { display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, data.label ?? ''),
      ),

      // Cross-links list
      links.length > 0 && e('div', {
        style: { borderTop: '1px solid #fde68a', padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 3 },
      },
        ...links.map((link, i) => e('div', {
          key: i,
          style: {
            display: 'flex', alignItems: 'center', gap: 4,
            background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: 4, padding: '2px 5px', fontSize: 10,
          },
        },
          // Icon + name (clickable → navigate)
          e('span', {
            style: { cursor: 'pointer', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#4f46e5' },
            title: `Go to ${TYPE_META[link.type]?.label ?? link.type}: ${link.name}`,
            onClick: (ev) => { ev.stopPropagation(); navigateToItem(link.type); },
          }, `${TYPE_META[link.type]?.icon ?? '🔗'} ${link.name}`),
          // Remove
          e('span', {
            style: { cursor: 'pointer', color: '#9ca3af', fontSize: 12, lineHeight: 1, flexShrink: 0 },
            title: 'Remove link',
            onClick: ev => removeLink(ev, i),
          }, '×'),
        )),
      ),

      // Add link button
      e('div', { style: { padding: '4px 6px', borderTop: links.length > 0 ? '1px solid #fde68a' : undefined } },
        e('button', {
          style: {
            background: 'none', border: '1px dashed #d97706', borderRadius: 4,
            fontSize: 10, padding: '2px 6px', cursor: 'pointer', color: '#d97706', width: '100%',
          },
          title: 'Link this note to an item',
          onClick: (ev) => { ev.stopPropagation(); ctx?.openLinkPicker(id); },
        }, '+ Link item'),
      ),
    );
  }

  // ── Rect / Pill (Task, Sub-Process, legacy) ──
  return e('div', {
    style: {
      padding: '8px 14px', paddingBottom: marker ? '18px' : '8px',
      fontSize: 12, fontFamily: 'inherit',
      border: `${bw} ${dashed ? 'dashed' : 'solid'} ${border}`,
      background: bg,
      borderRadius: shape === 'pill' ? '999px' : '6px',
      minWidth: 110, textAlign: 'center', lineHeight: 1.4,
      position: 'relative', cursor: 'default',
      boxShadow: selected ? '0 0 0 2.5px #6366f1' : undefined,
    },
    onDoubleClick: startEdit,
    title: 'Double-click to rename',
  },
    ...Handles(),
    editing
      ? inlineInput()
      : e('span', { style: { display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, data.label ?? ''),
    marker && e('span', {
      style: { position: 'absolute', bottom: 3, left: '50%', transform: 'translateX(-50%)', fontSize: 11, lineHeight: 1, color: border },
    }, marker),
  );
}

// ─── Custom Edge ──────────────────────────────────────────────────────────────

function FlowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  selected, data, markerEnd, markerStart, style,
}) {
  const { setEdges } = useReactFlow();
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft,   setLabelDraft]   = useState(data?.label ?? '');

  useEffect(() => { if (!editingLabel) setLabelDraft(data?.label ?? ''); }, [data?.label, editingLabel]);

  const edgeLineType = data?.edgeType ?? 'bezier';
  const bidir        = data?.bidir    ?? false;

  let edgePath, labelX, labelY;
  if (edgeLineType === 'step')
    [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  else if (edgeLineType === 'straight')
    [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  else
    [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const toggleBidir = useCallback((ev) => {
    ev.stopPropagation();
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : {
      ...edge, markerStart: !bidir ? { type: MarkerType.ArrowClosed } : undefined,
      data: { ...edge.data, bidir: !bidir },
    }));
  }, [id, bidir, setEdges]);

  const cycleLineType = useCallback((ev) => {
    ev.stopPropagation();
    const next = EDGE_TYPES_CYCLE[(EDGE_TYPES_CYCLE.indexOf(edgeLineType) + 1) % EDGE_TYPES_CYCLE.length];
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : { ...edge, data: { ...edge.data, edgeType: next } }));
  }, [id, edgeLineType, setEdges]);

  const startLabelEdit = useCallback((ev) => {
    ev?.stopPropagation(); setLabelDraft(data?.label ?? ''); setEditingLabel(true);
  }, [data?.label]);

  const confirmLabel = useCallback(() => {
    setEditingLabel(false);
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : { ...edge, data: { ...edge.data, label: labelDraft } }));
  }, [id, labelDraft, setEdges]);

  const onLabelKeyDown = useCallback((ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); confirmLabel(); }
    if (ev.key === 'Escape') setEditingLabel(false);
    ev.stopPropagation();
  }, [confirmLabel]);

  const deleteEdge = useCallback((ev) => {
    ev.stopPropagation();
    setEdges(eds => eds.filter(edge => edge.id !== id));
  }, [id, setEdges]);

  const edgeStyle = {
    ...style, strokeWidth: selected ? 2.5 : 1.5,
    stroke: selected ? '#6366f1' : (style?.stroke ?? '#b1b1b7'),
  };

  return e(React.Fragment, null,
    e(BaseEdge, { path: edgePath, markerEnd, markerStart, style: edgeStyle }),
    e(EdgeLabelRenderer, null,
      data?.label && !editingLabel && e('div', {
        className: 'nodrag nopan',
        style: {
          position: 'absolute', transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          fontSize: '11px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '4px',
          padding: '1px 7px', pointerEvents: 'all', cursor: 'pointer', userSelect: 'none',
          boxShadow: '0 1px 3px rgba(0,0,0,.07)',
        },
        onDoubleClick: startLabelEdit, title: 'Double-click to edit label',
      }, data.label),

      editingLabel && e('div', {
        className: 'nodrag nopan',
        style: { position: 'absolute', transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'all' },
      },
        e('input', {
          autoFocus: true, value: labelDraft, placeholder: 'Label…',
          onChange: ev => setLabelDraft(ev.target.value),
          onBlur: confirmLabel, onKeyDown: onLabelKeyDown,
          style: { fontSize: '11px', padding: '2px 8px', border: '1.5px solid #6366f1', borderRadius: '4px', outline: 'none', minWidth: 70, boxShadow: '0 0 0 3px rgba(99,102,241,.15)' },
        }),
      ),

      selected && !editingLabel && e('div', {
        className: 'nodrag nopan',
        style: {
          position: 'absolute', transform: `translate(-50%,-100%) translate(${labelX}px,${labelY - 14}px)`,
          display: 'flex', alignItems: 'center', gap: '1px',
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: '7px',
          padding: '3px 5px', boxShadow: '0 2px 8px rgba(0,0,0,.12)', pointerEvents: 'all',
        },
      },
        e('button', { style: { ...ETBTN, color: bidir ? '#6366f1' : undefined, fontWeight: bidir ? 700 : undefined }, onClick: toggleBidir, title: bidir ? 'Make one-directional' : 'Make bidirectional' }, '↔'),
        e('span', { style: { color: '#e5e7eb' } }, '│'),
        e('button', { style: ETBTN, onClick: cycleLineType, title: `Line: ${edgeLineType} — click to cycle` }, EDGE_TYPE_ICON[edgeLineType] ?? '⌒'),
        e('span', { style: { color: '#e5e7eb' } }, '│'),
        e('button', { style: ETBTN, onClick: startLabelEdit, title: data?.label ? 'Edit label' : 'Add label' }, '✏'),
        e('span', { style: { color: '#e5e7eb' } }, '│'),
        e('button', { style: { ...ETBTN, color: '#ef4444' }, onClick: deleteEdge, title: 'Delete connection' }, '✕'),
      ),
    ),
  );
}

// ─── Node / edge type maps ─────────────────────────────────────────────────────

const NODE_TYPES = {
  startEvent: FlowNode, intermediateEvent: FlowNode, endEvent: FlowNode,
  task: FlowNode, subProcess: FlowNode,
  xorGateway: FlowNode, andGateway: FlowNode, orGateway: FlowNode,
  annotation: FlowNode,
  input: FlowNode, output: FlowNode, default: FlowNode, decision: FlowNode,
};
const EDGE_TYPES = { default: FlowEdge };

// ─── Data helpers ─────────────────────────────────────────────────────────────

function parseData(raw) {
  try {
    const d = raw ? JSON.parse(raw) : null;
    if (d && Array.isArray(d.nodes)) {
      const edges = (d.edges ?? []).map(edge => ({
        ...edge, type: 'default',
        markerEnd:   edge.markerEnd   ?? { type: MarkerType.ArrowClosed },
        markerStart: edge.markerStart ?? undefined,
        data: { edgeType: 'bezier', bidir: false, ...(edge.data ?? {}) },
      }));
      const nodes = d.nodes.map(({ style: _s, ...rest }) => rest);
      return { nodes, edges };
    }
  } catch { /* fall through */ }
  return { nodes: [], edges: [] };
}

function stripInternalState(nodes, edges) {
  return {
    nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
    edges: edges.map(({ id, type, source, target, sourceHandle, targetHandle, markerEnd, markerStart, style, data }) =>
      ({ id, type, source, target, sourceHandle, targetHandle, markerEnd, markerStart, style, data })),
  };
}

// ─── Link Picker Modal ────────────────────────────────────────────────────────

function LinkPickerModal({ nodeId, setNodes, onClose }) {
  const [type,       setType]       = useState(LINK_TYPES[0]);
  const [items,      setItems]      = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading,    setLoading]    = useState(false);

  useEffect(() => {
    setLoading(true); setSelectedId('');
    fetch(`/api/linkable/${type}`)
      .then(r => r.json())
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [type]);

  const addLink = () => {
    const item = items.find(i => String(i.id) === selectedId);
    if (!item) return;
    setNodes(nds => nds.map(n => {
      if (n.id !== nodeId) return n;
      const links = n.data.links ?? [];
      if (links.find(l => l.type === type && l.id === item.id)) return n; // no dupe
      return { ...n, data: { ...n.data, links: [...links, { type, id: item.id, name: item.name }] } };
    }));
    onClose();
  };

  const overlay = {
    position: 'fixed', inset: 0, zIndex: 10000,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  const panel = {
    background: '#fff', borderRadius: 10, padding: 20, width: 360,
    maxHeight: '80vh', overflow: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,.2)',
    display: 'flex', flexDirection: 'column', gap: 10,
  };

  return e('div', { style: overlay, onClick: onClose },
    e('div', { style: panel, onClick: ev => ev.stopPropagation() },
      // Header
      e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        e('span', { style: { fontWeight: 700, fontSize: 14 } }, '🔗 Link Item to Note'),
        e('button', { onClick: onClose, style: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' } }, '×'),
      ),

      // Type picker
      e('div', null,
        e('label', { style: { fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 } }, 'Item type'),
        e('select', {
          value: type,
          onChange: ev => setType(ev.target.value),
          style: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, outline: 'none' },
        },
          ...LINK_TYPES.map(t => e('option', { key: t, value: t }, `${TYPE_META[t].icon} ${TYPE_META[t].label}`)),
        ),
      ),

      // Item list
      e('div', null,
        e('label', { style: { fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 } }, 'Select item'),
        loading
          ? e('div', { style: { textAlign: 'center', padding: '16px 0', color: '#9ca3af', fontSize: 12 } }, 'Loading…')
          : items.length === 0
            ? e('div', { style: { textAlign: 'center', padding: '16px 0', color: '#9ca3af', fontSize: 12 } }, 'No items found')
            : e('div', {
                style: { maxHeight: 200, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 },
              },
                ...items.map((item, i) => e('div', {
                  key: item.id,
                  onClick: () => setSelectedId(String(item.id)),
                  style: {
                    padding: '7px 10px', cursor: 'pointer', fontSize: 12,
                    background: String(item.id) === selectedId ? '#ede9fe' : i % 2 === 0 ? '#fafafa' : '#fff',
                    borderBottom: '1px solid #f3f4f6',
                    display: 'flex', alignItems: 'center', gap: 6,
                  },
                },
                  e('span', { style: { fontSize: 14 } }, TYPE_META[type]?.icon ?? '🔗'),
                  e('span', null, item.name),
                )),
              ),
      ),

      // Actions
      e('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 } },
        e('button', { className: 'btn btn-secondary', onClick: onClose }, 'Cancel'),
        e('button', {
          className: 'btn btn-primary',
          onClick: addLink,
          disabled: !selectedId,
          style: { opacity: selectedId ? 1 : 0.5 },
        }, 'Add Link'),
      ),
    ),
  );
}

// ─── Toolbar helpers ──────────────────────────────────────────────────────────

function TBtn({ onClick, title, children, danger }) {
  return e('button', {
    className: 'btn btn-secondary btn-sm',
    onClick, title,
    style: danger ? { color: 'var(--danger)' } : undefined,
  }, children);
}

function SectionHdr({ label }) {
  return e('span', {
    style: { fontSize: 9, color: '#9ca3af', display: 'block', marginTop: 2, marginBottom: 1 },
  }, label);
}

// ─── Main FlowchartEditor ─────────────────────────────────────────────────────

function FlowchartEditor({ initialData, onSave }) {
  const seed = useMemo(() => parseData(initialData), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seed.edges);
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);

  // Single toolbar toggle
  const [toolbarOpen, setToolbarOpen] = useState(true);

  // Link picker state
  const [picker, setPicker] = useState({ open: false, nodeId: null });
  const openLinkPicker = useCallback(nodeId => setPicker({ open: true, nodeId }), []);
  const closePicker    = useCallback(() => setPicker({ open: false, nodeId: null }), []);

  const ctxValue = useMemo(() => ({ openLinkPicker }), [openLinkPicker]);

  const initRef = useRef(false);
  useEffect(() => {
    if (!initRef.current) { initRef.current = true; return; }
    setDirty(true);
  }, [nodes, edges]);

  const onConnect = useCallback((params) => {
    setEdges(eds => addEdge({
      ...params, type: 'default',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 1.5 },
      data: { edgeType: 'bezier', bidir: false },
    }, eds));
  }, [setEdges]);

  const addNode = useCallback((type) => {
    setNodes(nds => {
      const col = nds.length % 4;
      const row = Math.floor(nds.length / 4);
      const def = NODE_DEF[type] ?? NODE_DEF.task;
      return [...nds, { id: nextId(), type, position: { x: 60 + col * 180, y: 60 + row * 140 }, data: { label: def.label ?? '' } }];
    });
  }, [setNodes]);

  const deleteSelected = useCallback(() => {
    setNodes(nds => nds.filter(n => !n.selected));
    setEdges(eds => eds.filter(e => !e.selected));
  }, [setNodes, setEdges]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try { await onSave(stripInternalState(nodes, edges)); setDirty(false); }
    finally { setSaving(false); }
  }, [nodes, edges, onSave]);

  const vsep = e('span', { style: { width: 1, background: '#e5e7eb', alignSelf: 'stretch', margin: '0 2px' } });

  return e(FlowCtx.Provider, { value: ctxValue },
    e('div', { style: { height: '520px', width: '100%' } },
      e(ReactFlow, {
        nodes, edges, nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES,
        onNodesChange, onEdgesChange, onConnect,
        fitView: true, fitViewOptions: { padding: 0.3 },
        deleteKeyCode: 'Delete', connectionMode: 'loose',
        style: { background: '#f8fafc' },
      },
        e(Controls),
        e(Background, { variant: BackgroundVariant.Dots, gap: 16, size: 1 }),

        e(Panel, { position: 'top-left' },
          e('div', {
            style: {
              background: 'rgba(255,255,255,0.94)',
              border: '1px solid #e5e7eb', borderRadius: 8,
              boxShadow: '0 2px 8px rgba(0,0,0,.08)',
              overflow: 'hidden',
              minWidth: toolbarOpen ? undefined : 0,
            },
          },
            // ── Toggle header ──
            e('div', {
              style: {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '4px 8px', borderBottom: toolbarOpen ? '1px solid #f3f4f6' : 'none',
                cursor: 'pointer', userSelect: 'none',
              },
              onClick: () => setToolbarOpen(o => !o),
              title: toolbarOpen ? 'Collapse toolbar' : 'Expand toolbar',
            },
              e('span', { style: { fontSize: 10, fontWeight: 600, color: '#6b7280' } }, 'BPMN Blocks'),
              e('span', { style: { fontSize: 11, color: '#9ca3af' } }, toolbarOpen ? '▲' : '▼'),
            ),

            // ── Buttons (hidden when collapsed) ──
            toolbarOpen && e('div', { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 } },
              e('div', null,
                e(SectionHdr, { label: 'Events' }),
                e('div', { style: { display: 'flex', gap: 3, flexWrap: 'wrap' } },
                  e(TBtn, { key: 'se', onClick: () => addNode('startEvent'),        title: 'Add Start Event'        }, '⬤ Start'),
                  e(TBtn, { key: 'ie', onClick: () => addNode('intermediateEvent'), title: 'Add Intermediate Event' }, '◎ Interm.'),
                  e(TBtn, { key: 'ee', onClick: () => addNode('endEvent'),          title: 'Add End Event'          }, '⬤ End'),
                ),
              ),
              e('div', null,
                e(SectionHdr, { label: 'Activities' }),
                e('div', { style: { display: 'flex', gap: 3, flexWrap: 'wrap' } },
                  e(TBtn, { key: 'ta', onClick: () => addNode('task'),       title: 'Add Task'        }, '▭ Task'),
                  e(TBtn, { key: 'sp', onClick: () => addNode('subProcess'), title: 'Add Sub-Process' }, '▭⊕ Sub-Process'),
                ),
              ),
              e('div', null,
                e(SectionHdr, { label: 'Gateways' }),
                e('div', { style: { display: 'flex', gap: 3, flexWrap: 'wrap' } },
                  e(TBtn, { key: 'xg', onClick: () => addNode('xorGateway'), title: 'Exclusive Gateway (XOR)' }, '◇× XOR'),
                  e(TBtn, { key: 'ag', onClick: () => addNode('andGateway'), title: 'Parallel Gateway (AND)'  }, '◇+ AND'),
                  e(TBtn, { key: 'og', onClick: () => addNode('orGateway'),  title: 'Inclusive Gateway (OR)'  }, '◇○ OR'),
                ),
              ),
              e('div', null,
                e(SectionHdr, { label: 'Artifacts' }),
                e('div', { style: { display: 'flex', gap: 3, flexWrap: 'wrap' } },
                  e(TBtn, { key: 'an', onClick: () => addNode('annotation'), title: 'Add Annotation / Note' }, '[ Note'),
                ),
              ),
              e('div', { style: { display: 'flex', gap: 3, alignItems: 'center', marginTop: 4, paddingTop: 6, borderTop: '1px solid #f3f4f6' } },
                e(TBtn, { key: 'del', onClick: deleteSelected, title: 'Delete selected (or press Delete key)', danger: true }, '✕ Delete'),
                vsep,
                e('button', {
                  key: 'save',
                  className: `btn btn-sm ${dirty ? 'btn-primary' : 'btn-secondary'}`,
                  onClick: handleSave, disabled: !dirty || saving,
                  style: { opacity: dirty ? 1 : 0.5 },
                }, saving ? 'Saving…' : dirty ? '● Save' : '✓ Saved'),
              ),
            ),
          ),
        ),
      ),
    ),

    // Link picker rendered outside ReactFlow to avoid clipping
    picker.open && e(LinkPickerModal, {
      nodeId: picker.nodeId,
      setNodes,
      onClose: closePicker,
    }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

const _roots = {};

window.FlowchartEditor = {
  mount(containerId, initialData, onSave) {
    const container = document.getElementById(containerId);
    if (!container) return;
    this.unmount(containerId);
    const root = createRoot(container);
    _roots[containerId] = root;
    root.render(e(FlowchartEditor, { initialData, onSave }));
  },
  unmount(containerId) {
    if (_roots[containerId]) {
      _roots[containerId].unmount();
      delete _roots[containerId];
    }
  },
};
