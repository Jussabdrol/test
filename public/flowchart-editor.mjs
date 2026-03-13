/**
 * flowchart-editor.mjs
 * Drag-and-drop process flowchart editor powered by React Flow.
 * Loaded as an ES module; exposes window.FlowchartEditor for vanilla JS callers.
 *
 * Usage (from app.js):
 *   window.FlowchartEditor.mount('container-id', jsonString, onSave)
 *   window.FlowchartEditor.unmount('container-id')
 */

import React, { useState, useCallback, useMemo } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  Panel,
  MarkerType,
  BackgroundVariant,
} from 'https://esm.sh/@xyflow/react@12?deps=react@18,react-dom@18';

// ─── helpers ────────────────────────────────────────────────────────────────

const e = React.createElement;
let _seq = 0;
const nextId = () => `n${++_seq}-${Date.now()}`;

const BASE_STYLE = {
  padding: '8px 16px',
  fontSize: '12px',
  fontFamily: 'inherit',
  border: '1.5px solid #d1d5db',
  background: '#ffffff',
  borderRadius: '6px',
  minWidth: '110px',
  textAlign: 'center',
  cursor: 'grab',
};

const NODE_STYLES = {
  input:   { ...BASE_STYLE, background: '#d1fae5', borderColor: '#6ee7b7', borderRadius: '20px' },
  output:  { ...BASE_STYLE, background: '#fee2e2', borderColor: '#fca5a5', borderRadius: '20px' },
  default: { ...BASE_STYLE },
};

const NODE_LABELS = { input: 'Start', output: 'End', default: 'Step' };

function parseData(raw) {
  try {
    const d = raw ? JSON.parse(raw) : null;
    if (d && Array.isArray(d.nodes) && Array.isArray(d.edges)) return d;
  } catch { /* fall through */ }
  return { nodes: [], edges: [] };
}

function stripInternalState(nodes, edges) {
  return {
    nodes: nodes.map(({ id, type, position, data, style }) => ({ id, type, position, data, style })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle, markerEnd, style, label, animated }) =>
      ({ id, source, target, sourceHandle, targetHandle, markerEnd, style, label, animated })
    ),
  };
}

// ─── React Flow component ────────────────────────────────────────────────────

function FlowchartEditor({ initialData, onSave }) {
  const seed = useMemo(() => parseData(initialData), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seed.edges);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const onConnect = useCallback((params) => {
    setEdges(eds => addEdge({
      ...params,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 1.5 },
    }, eds));
    setDirty(true);
  }, [setEdges]);

  const onNodesChangeTracked = useCallback((changes) => {
    onNodesChange(changes);
    if (changes.some(c => c.type !== 'select' && c.type !== 'dimensions')) setDirty(true);
  }, [onNodesChange]);

  const onEdgesChangeTracked = useCallback((changes) => {
    onEdgesChange(changes);
    if (changes.some(c => c.type !== 'select')) setDirty(true);
  }, [onEdgesChange]);

  const addNode = useCallback((type) => {
    setNodes(nds => {
      const col = nds.length % 4;
      const row = Math.floor(nds.length / 4);
      return [...nds, {
        id: nextId(),
        type,
        position: { x: 60 + col * 180, y: 60 + row * 120 },
        data: { label: NODE_LABELS[type] || 'Step' },
        style: NODE_STYLES[type] || NODE_STYLES.default,
      }];
    });
    setDirty(true);
  }, [setNodes]);

  const deleteSelected = useCallback(() => {
    setNodes(nds => nds.filter(n => !n.selected));
    setEdges(eds => eds.filter(e => !e.selected));
    setDirty(true);
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

  // ── toolbar buttons ──
  const btnBase = { className: 'btn btn-secondary btn-sm' };
  const toolbar = e(Panel, { position: 'top-left' },
    e('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
      e('button', { ...btnBase, onClick: () => addNode('input'),   title: 'Add Start node' },  '+ Start'),
      e('button', { ...btnBase, onClick: () => addNode('default'), title: 'Add process step' }, '+ Step'),
      e('button', { ...btnBase, onClick: () => addNode('output'),  title: 'Add End node' },    '+ End'),
      e('button', { ...btnBase,
        onClick: deleteSelected,
        style: { color: 'var(--danger)' },
        title: 'Delete selected nodes / edges  (or press Delete key)',
      }, '✕ Delete'),
      e('button', {
        className: `btn btn-sm ${dirty ? 'btn-primary' : 'btn-secondary'}`,
        onClick: handleSave,
        disabled: !dirty || saving,
        style: { marginLeft: '8px', opacity: dirty ? 1 : 0.55 },
        title: 'Save flowchart',
      }, saving ? 'Saving…' : dirty ? '● Save' : '✓ Saved'),
    )
  );

  return e('div', { style: { height: '440px', width: '100%' } },
    e(ReactFlow, {
      nodes,
      edges,
      onNodesChange: onNodesChangeTracked,
      onEdgesChange: onEdgesChangeTracked,
      onConnect,
      fitView: true,
      fitViewOptions: { padding: 0.3 },
      deleteKeyCode: 'Delete',
      style: { background: '#f8fafc' },
    },
      e(Controls),
      e(Background, { variant: BackgroundVariant.Dots, gap: 16, size: 1 }),
      toolbar,
    )
  );
}

// ─── public API (called from vanilla app.js) ─────────────────────────────────

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
