/**
 * flowchart-editor.mjs
 * Full-featured drag-and-drop process flowchart editor (React Flow).
 * Exposed as window.FlowchartEditor { mount, unmount } for vanilla JS callers.
 *
 * Node editing  : double-click any node label to rename it inline
 * Edge editing  : click an edge to select it → floating toolbar appears:
 *                 ↔ bidirectional  |  ⌒/⌐/— line type  |  ✏ label  |  ✕ delete
 * Edge labels   : double-click an edge label to edit it inline
 * Delete        : select anything → Delete key  OR  ✕ in edge toolbar
 * Connections   : drag from any of the 4 handles on a node to any other handle
 */

import React, {
  useState, useCallback, useEffect, useRef, useMemo,
} from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Controls,
  Background,
  Panel,
  MarkerType,
  BackgroundVariant,
  Handle,
  Position,
  EdgeLabelRenderer,
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
} from 'https://esm.sh/@xyflow/react@12?deps=react@18,react-dom@18';

// ─── Shared constants ────────────────────────────────────────────────────────

const e = React.createElement;
let _seq = 0;
const nextId = () => `n${++_seq}-${Date.now()}`;

const NODE_BASE = {
  padding: '8px 14px',
  fontSize: '12px',
  fontFamily: 'inherit',
  border: '1.5px solid #d1d5db',
  background: '#ffffff',
  borderRadius: '6px',
  minWidth: '110px',
  textAlign: 'center',
  lineHeight: '1.4',
};

const TYPE_STYLE = {
  input:    { ...NODE_BASE, background: '#d1fae5', borderColor: '#34d399', borderRadius: '999px' },
  output:   { ...NODE_BASE, background: '#fee2e2', borderColor: '#f87171', borderRadius: '999px' },
  default:  { ...NODE_BASE },
  decision: { ...NODE_BASE, background: '#fef3c7', borderColor: '#fbbf24', borderWidth: '2px', borderStyle: 'dashed' },
};

const TYPE_DEFAULT_LABEL = { input: 'Start', output: 'End', default: 'Step', decision: 'Decision?' };

const HANDLE_SX = {
  width: 9, height: 9,
  background: '#6366f1',
  border: '2px solid #fff',
  borderRadius: '50%',
  zIndex: 10,
};

// Edge toolbar/label shared button style
const ETBTN = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '13px', padding: '2px 5px',
  color: '#374151', borderRadius: '3px', lineHeight: 1.3,
};

const EDGE_TYPES_CYCLE = ['bezier', 'step', 'straight'];
const EDGE_TYPE_ICON   = { bezier: '⌒', step: '⌐', straight: '—' };

// ─── Custom Node ─────────────────────────────────────────────────────────────
// All types (input / default / output / decision) share one component.
// Double-click the label to rename inline; Enter or blur to confirm; Esc to cancel.

function FlowNode({ id, data, type, selected }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(data.label ?? '');
  const inputRef = useRef(null);

  // Sync external label changes (e.g. undo / initial load)
  useEffect(() => { if (!editing) setDraft(data.label ?? ''); }, [data.label, editing]);

  // Focus + select-all when edit mode activates
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const confirm = useCallback(() => {
    setEditing(false);
    const v = draft.trim();
    if (v) updateNodeData(id, { label: v });
    else   setDraft(data.label ?? '');
  }, [draft, id, updateNodeData, data.label]);

  const onKeyDown = useCallback((ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); confirm(); }
    if (ev.key === 'Escape') { setDraft(data.label ?? ''); setEditing(false); }
    ev.stopPropagation(); // prevent ReactFlow from swallowing Delete / arrow keys
  }, [confirm, data.label]);

  const baseStyle = {
    ...(TYPE_STYLE[type] ?? TYPE_STYLE.default),
    boxShadow: selected ? '0 0 0 2.5px #6366f1' : undefined,
    position: 'relative',
  };

  return e('div', {
    style: baseStyle,
    onDoubleClick: (ev) => { ev.stopPropagation(); setEditing(true); },
    title: editing ? undefined : 'Double-click to rename',
  },
    // Four handles – all act as both source & target (connectionMode="loose")
    e(Handle, { type: 'source', position: Position.Top,    id: 't', style: { ...HANDLE_SX, top:    -5 } }),
    e(Handle, { type: 'source', position: Position.Right,  id: 'r', style: { ...HANDLE_SX, right:  -5 } }),
    e(Handle, { type: 'source', position: Position.Bottom, id: 'b', style: { ...HANDLE_SX, bottom: -5 } }),
    e(Handle, { type: 'source', position: Position.Left,   id: 'l', style: { ...HANDLE_SX, left:   -5 } }),

    editing
      ? e('input', {
          ref: inputRef,
          value: draft,
          onChange: ev => setDraft(ev.target.value),
          onBlur: confirm,
          onKeyDown,
          style: {
            width: '100%', minWidth: 60,
            border: 'none', outline: 'none',
            background: 'transparent',
            textAlign: 'center',
            fontSize: 'inherit', fontFamily: 'inherit',
            padding: 0,
          },
        })
      : e('span', {
          style: { display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        }, data.label ?? ''),
  );
}

// ─── Custom Edge ─────────────────────────────────────────────────────────────
// Shows a floating toolbar when selected:
//   ↔ bidirectional  |  ⌒/⌐/— line type  |  ✏ label  |  ✕ delete
// Double-click the label chip to edit it inline.

function FlowEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  selected,
  data,
  markerEnd,
  markerStart,
  style,
}) {
  const { setEdges } = useReactFlow();
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft,   setLabelDraft]   = useState(data?.label ?? '');

  // Sync label if changed externally
  useEffect(() => { if (!editingLabel) setLabelDraft(data?.label ?? ''); }, [data?.label, editingLabel]);

  const edgeLineType = data?.edgeType ?? 'bezier';
  const bidir        = data?.bidir    ?? false;

  // Compute path
  let edgePath, labelX, labelY;
  if (edgeLineType === 'step') {
    [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  } else if (edgeLineType === 'straight') {
    [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  } else {
    [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }

  // ── Toolbar actions ──

  const toggleBidir = useCallback((ev) => {
    ev.stopPropagation();
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : {
      ...edge,
      markerStart: !bidir ? { type: MarkerType.ArrowClosed } : undefined,
      data: { ...edge.data, bidir: !bidir },
    }));
  }, [id, bidir, setEdges]);

  const cycleLineType = useCallback((ev) => {
    ev.stopPropagation();
    const next = EDGE_TYPES_CYCLE[(EDGE_TYPES_CYCLE.indexOf(edgeLineType) + 1) % EDGE_TYPES_CYCLE.length];
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : {
      ...edge,
      data: { ...edge.data, edgeType: next },
    }));
  }, [id, edgeLineType, setEdges]);

  const startLabelEdit = useCallback((ev) => {
    ev?.stopPropagation();
    setLabelDraft(data?.label ?? '');
    setEditingLabel(true);
  }, [data?.label]);

  const confirmLabel = useCallback(() => {
    setEditingLabel(false);
    setEdges(eds => eds.map(edge => edge.id !== id ? edge : {
      ...edge,
      data: { ...edge.data, label: labelDraft },
    }));
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

  // Edge appearance
  const edgeStyle = {
    ...style,
    strokeWidth: selected ? 2.5 : 1.5,
    stroke: selected ? '#6366f1' : (style?.stroke ?? '#b1b1b7'),
  };

  // Toolbar position – floats above label midpoint
  const toolbarY = labelY - 14;

  return e(React.Fragment, null,
    e(BaseEdge, { path: edgePath, markerEnd, markerStart, style: edgeStyle }),

    e(EdgeLabelRenderer, null,

      // ── Edge label chip (always visible if label set) ──
      data?.label && !editingLabel && e('div', {
        className: 'nodrag nopan',
        style: {
          position: 'absolute',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          fontSize: '11px',
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '4px',
          padding: '1px 7px',
          pointerEvents: 'all',
          cursor: 'pointer',
          userSelect: 'none',
          boxShadow: '0 1px 3px rgba(0,0,0,.07)',
        },
        onDoubleClick: startLabelEdit,
        title: 'Double-click to edit label',
      }, data.label),

      // ── Inline label editor ──
      editingLabel && e('div', {
        className: 'nodrag nopan',
        style: {
          position: 'absolute',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          pointerEvents: 'all',
        },
      },
        e('input', {
          autoFocus: true,
          value: labelDraft,
          placeholder: 'Label…',
          onChange: ev => setLabelDraft(ev.target.value),
          onBlur: confirmLabel,
          onKeyDown: onLabelKeyDown,
          style: {
            fontSize: '11px', padding: '2px 8px',
            border: '1.5px solid #6366f1', borderRadius: '4px',
            outline: 'none', minWidth: 70,
            boxShadow: '0 0 0 3px rgba(99,102,241,.15)',
          },
        }),
      ),

      // ── Floating toolbar (only when edge is selected) ──
      selected && !editingLabel && e('div', {
        className: 'nodrag nopan',
        style: {
          position: 'absolute',
          transform: `translate(-50%,-100%) translate(${labelX}px,${toolbarY}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: '1px',
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '7px',
          padding: '3px 5px',
          boxShadow: '0 2px 8px rgba(0,0,0,.12)',
          pointerEvents: 'all',
        },
      },
        // Bidirectional toggle
        e('button', {
          style: { ...ETBTN, color: bidir ? '#6366f1' : undefined, fontWeight: bidir ? 700 : undefined },
          onClick: toggleBidir,
          title: bidir ? 'Make one-directional' : 'Make bidirectional',
        }, '↔'),

        e('span', { style: { color: '#e5e7eb' } }, '│'),

        // Line-type cycle
        e('button', {
          style: ETBTN,
          onClick: cycleLineType,
          title: `Line: ${edgeLineType} — click to cycle`,
        }, EDGE_TYPE_ICON[edgeLineType] ?? '⌒'),

        e('span', { style: { color: '#e5e7eb' } }, '│'),

        // Label edit
        e('button', {
          style: ETBTN,
          onClick: startLabelEdit,
          title: data?.label ? 'Edit label' : 'Add label',
        }, '✏'),

        e('span', { style: { color: '#e5e7eb' } }, '│'),

        // Delete
        e('button', {
          style: { ...ETBTN, color: '#ef4444' },
          onClick: deleteEdge,
          title: 'Delete connection',
        }, '✕'),
      ),
    ),
  );
}

// ─── Node / edge type maps – defined OUTSIDE component to stay stable ─────────
const NODE_TYPES = {
  input:    FlowNode,
  output:   FlowNode,
  default:  FlowNode,
  decision: FlowNode,
};
const EDGE_TYPES = { default: FlowEdge };

// ─── Data helpers ─────────────────────────────────────────────────────────────

function parseData(raw) {
  try {
    const d = raw ? JSON.parse(raw) : null;
    if (d && Array.isArray(d.nodes)) {
      // Normalise edges: ensure our custom type and default data fields
      const edges = (d.edges ?? []).map(edge => ({
        ...edge,
        type: 'default',
        markerEnd:   edge.markerEnd   ?? { type: MarkerType.ArrowClosed },
        markerStart: edge.markerStart ?? undefined,
        data: { edgeType: 'bezier', bidir: false, ...(edge.data ?? {}) },
      }));
      // Strip legacy `style` from nodes — FlowNode component is the sole style source
      const nodes = d.nodes.map(({ style: _s, ...rest }) => rest);
      return { nodes, edges };
    }
  } catch { /* fall through */ }
  return { nodes: [], edges: [] };
}

function stripInternalState(nodes, edges) {
  return {
    nodes: nodes.map(({ id, type, position, data }) =>
      ({ id, type, position, data })
    ),
    edges: edges.map(({ id, type, source, target, sourceHandle, targetHandle, markerEnd, markerStart, style, data }) =>
      ({ id, type, source, target, sourceHandle, targetHandle, markerEnd, markerStart, style, data })
    ),
  };
}

// ─── Main FlowchartEditor component ──────────────────────────────────────────

function FlowchartEditor({ initialData, onSave }) {
  const seed = useMemo(() => parseData(initialData), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seed.edges);
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);

  // Detect ANY change (incl. toolbar actions inside custom edge components)
  // by watching the state references rather than intercepting every setter.
  const initRef = useRef(false);
  useEffect(() => {
    if (!initRef.current) { initRef.current = true; return; }
    setDirty(true);
  }, [nodes, edges]);

  const onConnect = useCallback((params) => {
    setEdges(eds => addEdge({
      ...params,
      type: 'default',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 1.5 },
      data: { edgeType: 'bezier', bidir: false },
    }, eds));
  }, [setEdges]);

  const addNode = useCallback((type) => {
    setNodes(nds => {
      const col = nds.length % 4;
      const row = Math.floor(nds.length / 4);
      return [...nds, {
        id: nextId(),
        type,
        position: { x: 60 + col * 180, y: 60 + row * 130 },
        data: { label: TYPE_DEFAULT_LABEL[type] ?? 'Step' },
      }];
    });
  }, [setNodes]);

  const deleteSelected = useCallback(() => {
    setNodes(nds => nds.filter(n => !n.selected));
    setEdges(eds => eds.filter(e => !e.selected));
  }, [setNodes, setEdges]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(stripInternalState(nodes, edges));
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, onSave]);

  return e('div', { style: { height: '460px', width: '100%' } },
    e(ReactFlow, {
      nodes,
      edges,
      nodeTypes: NODE_TYPES,
      edgeTypes: EDGE_TYPES,
      onNodesChange,
      onEdgesChange,
      onConnect,
      fitView: true,
      fitViewOptions: { padding: 0.3 },
      deleteKeyCode: 'Delete',
      connectionMode: 'loose',   // any handle → any handle
      style: { background: '#f8fafc' },
    },
      e(Controls),
      e(Background, { variant: BackgroundVariant.Dots, gap: 16, size: 1 }),

      // ── Toolbar panel ──
      e(Panel, { position: 'top-left' },
        e('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
          e('button', { className: 'btn btn-secondary btn-sm', onClick: () => addNode('input'),    title: 'Add Start node'    }, '+ Start'),
          e('button', { className: 'btn btn-secondary btn-sm', onClick: () => addNode('default'),  title: 'Add process step'  }, '+ Step'),
          e('button', { className: 'btn btn-secondary btn-sm', onClick: () => addNode('decision'), title: 'Add Decision node' }, '+ Decision'),
          e('button', { className: 'btn btn-secondary btn-sm', onClick: () => addNode('output'),   title: 'Add End node'      }, '+ End'),
          e('button', {
            className: 'btn btn-secondary btn-sm',
            onClick: deleteSelected,
            style: { color: 'var(--danger)' },
            title: 'Delete selected (or press Delete key)',
          }, '✕ Delete'),
          e('button', {
            className: `btn btn-sm ${dirty ? 'btn-primary' : 'btn-secondary'}`,
            onClick: handleSave,
            disabled: !dirty || saving,
            style: { marginLeft: '8px', opacity: dirty ? 1 : 0.5 },
          }, saving ? 'Saving…' : dirty ? '● Save' : '✓ Saved'),
        ),
      ),
    ),
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
