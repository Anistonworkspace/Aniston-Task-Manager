import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Workflow as WorkflowIcon, Loader2, AlertCircle, Zap, PlayCircle,
  GitBranch, Play, History,
} from 'lucide-react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';

import {
  getWorkflow,
  updateWorkflow as updateWorkflowApi,
  createNode as createNodeApi,
  updateNode as updateNodeApi,
  deleteNode as deleteNodeApi,
  createEdge as createEdgeApi,
  deleteEdge as deleteEdgeApi,
  testRunWorkflow as testRunWorkflowApi,
} from '../../services/workflowsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';

import WorkflowNodePalette, { DRAG_MIME } from './WorkflowNodePalette';
import NodeConfigSidebar from './NodeConfigSidebar';
import RunHistoryDrawer from './RunHistoryDrawer';
import { findCatalogEntry } from './workflowCatalog';

/**
 * WorkflowCanvasPage — reactflow-backed visual canvas for editing a single
 * workflow's trigger → action chain. Layout:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← Back  [Workflow title (rename)]            [Publish toggle]│
 *   ├──────────────┬──────────────────────────────┬────────────────┤
 *   │ Palette      │ reactflow canvas             │ ConfigSidebar  │
 *   │ (Triggers /  │                              │ (on select)    │
 *   │  Actions)    │                              │                │
 *   └──────────────┴──────────────────────────────┴────────────────┘
 *
 * Server contract (see workflowsService):
 *   GET    /api/workflows/:id                   → { workflow, nodes, edges }
 *   PATCH  /api/workflows/:id                   → { workflow }
 *   POST   /api/workflows/:id/nodes             → { node }
 *   PATCH  /api/workflows/:id/nodes/:nodeId     → { node }
 *   DELETE /api/workflows/:id/nodes/:nodeId
 *   POST   /api/workflows/:id/edges             → { edge }
 *   DELETE /api/workflows/:id/edges/:edgeId
 *
 * v1 limitations: single trigger per workflow, linear action chain,
 * conditions/branches are palette-only "coming soon" pills. Position drags
 * are debounced 500ms before being PATCHed. Self-loops + duplicate edges
 * are rejected client-side with a toast.
 */

const POSITION_DEBOUNCE_MS = 500;

// reactflow domain-node type strings. Two custom node renderers below.
function ConditionNode({ data, selected }) {
  const entry = findCatalogEntry('condition', data.kind);
  return (
    <div
      className={`px-3 py-2 rounded-lg shadow-sm border-2 bg-white min-w-[180px] ${
        selected ? 'border-violet-500' : 'border-violet-300'
      }`}
      style={{ boxShadow: selected ? '0 4px 14px rgba(168,85,247,0.25)' : undefined }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <span
          className="w-6 h-6 rounded inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#a855f7' }}
        >
          <GitBranch size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-wide font-bold text-violet-700">Condition</div>
          <div className="text-xs font-semibold text-zinc-900 truncate">
            {entry?.label || data.kind}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const NODE_TYPES = {
  trigger: TriggerNode,
  action: ActionNode,
  condition: ConditionNode,
};

function TriggerNode({ data, selected }) {
  const entry = findCatalogEntry('trigger', data.kind);
  return (
    <div
      className={`px-3 py-2 rounded-lg shadow-sm border-2 bg-white min-w-[180px] ${
        selected ? 'border-amber-500' : 'border-amber-300'
      }`}
      style={{ boxShadow: selected ? '0 4px 14px rgba(245,158,11,0.25)' : undefined }}
    >
      <div className="flex items-center gap-2">
        <span
          className="w-6 h-6 rounded inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.18)', color: '#d97706' }}
        >
          <Zap size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-wide font-bold text-amber-700">Trigger</div>
          <div className="text-xs font-semibold text-zinc-900 truncate">
            {entry?.label || data.kind}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function ActionNode({ data, selected }) {
  const entry = findCatalogEntry('action', data.kind);
  return (
    <div
      className={`px-3 py-2 rounded-lg shadow-sm border-2 bg-white min-w-[180px] ${
        selected ? 'border-blue-500' : 'border-blue-300'
      }`}
      style={{ boxShadow: selected ? '0 4px 14px rgba(59,130,246,0.25)' : undefined }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <span
          className="w-6 h-6 rounded inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(59, 130, 246, 0.18)', color: '#2563eb' }}
        >
          <PlayCircle size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-wide font-bold text-blue-700">Action</div>
          <div className="text-xs font-semibold text-zinc-900 truncate">
            {entry?.label || data.kind}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ── Shape conversion: server JSON ↔ reactflow's node/edge shape ──────────
// Server nodes carry { id, type:'trigger'|'action', kind, config, position }.
// reactflow nodes are { id, type, position, data: { kind, config } } — `type`
// keys into NODE_TYPES, `data` is whatever payload our renderers consume.
function toRfNode(serverNode) {
  return {
    id: serverNode.id,
    type: serverNode.type, // 'trigger' or 'action'
    position: serverNode.position || { x: 0, y: 0 },
    data: {
      kind: serverNode.kind,
      config: serverNode.config || {},
    },
  };
}

function toRfEdge(serverEdge) {
  // Phase W2 — surface the `branch` flag as the edge label so the canvas
  // tells the author which path is the true/false leg out of a condition.
  const branchLabel = serverEdge.branch === 'true'
    ? 'Yes'
    : serverEdge.branch === 'false'
      ? 'No'
      : undefined;
  return {
    id: serverEdge.id,
    source: serverEdge.sourceNodeId,
    target: serverEdge.targetNodeId,
    label: branchLabel,
    data: { branch: serverEdge.branch || null },
  };
}

export default function WorkflowCanvasPage() {
  // ReactFlowProvider gives nested hooks access to the same internal store.
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner() {
  const { id: workflowId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [workflow, setWorkflow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [savingNode, setSavingNode] = useState(false);
  const [testRunBusy, setTestRunBusy] = useState(false);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);

  // Title-rename state — mirrors DocPage's inline-rename pattern.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // reactflow's own controlled state. Hydrated from the server response on
  // mount; we keep it in sync via the standard onNodesChange / onEdgesChange
  // helpers (drag, select, remove).
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [selectedNodeId, setSelectedNodeId] = useState(null);

  // Debounce buffer: when reactflow reports position changes during a drag,
  // we accumulate the latest position per-node and flush 500ms after the
  // user stops moving. Avoids one PATCH per pixel.
  const positionFlushTimers = useRef({}); // { [nodeId]: timeoutId }

  const wrapperRef = useRef(null);

  // ─── Load workflow on mount ────────────────────────────────────────
  useEffect(() => {
    if (!workflowId) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    getWorkflow(workflowId)
      .then(({ workflow: wf, nodes: srvNodes = [], edges: srvEdges = [] }) => {
        if (cancelled) return;
        setWorkflow(wf);
        setTitleDraft(wf?.name || '');
        setNodes(srvNodes.map(toRfNode));
        setEdges(srvEdges.map(toRfEdge));
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[WorkflowCanvasPage] load error', err);
        setLoadError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      // Clear any pending position flushes for nodes that may not exist
      // anymore by the time the timer fires.
      Object.values(positionFlushTimers.current).forEach(clearTimeout);
      positionFlushTimers.current = {};
    };
  }, [workflowId, setNodes, setEdges]);

  // ─── Derived: the currently-selected reactflow node (for the sidebar) ─
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const rf = nodes.find((n) => n.id === selectedNodeId);
    if (!rf) return null;
    return {
      id: rf.id,
      type: rf.type,
      kind: rf.data.kind,
      config: rf.data.config || {},
    };
  }, [selectedNodeId, nodes]);

  const hasTriggerNode = useMemo(
    () => nodes.some((n) => n.type === 'trigger'),
    [nodes]
  );

  // ─── Title rename ─────────────────────────────────────────────────
  const commitTitle = useCallback(async () => {
    if (!editingTitle) return;
    setEditingTitle(false);
    const trimmed = (titleDraft || '').trim();
    if (!trimmed || trimmed === workflow?.name) {
      setTitleDraft(workflow?.name || '');
      return;
    }
    try {
      const { workflow: updated } = await updateWorkflowApi(workflowId, { name: trimmed });
      setWorkflow((w) => ({ ...w, ...updated }));
      toast.success('Renamed');
    } catch (err) {
      setTitleDraft(workflow?.name || '');
      toast.error(getErrorMessage(err));
    }
  }, [editingTitle, titleDraft, workflow?.name, workflowId, toast]);

  // ─── Publish toggle ───────────────────────────────────────────────
  const handleTogglePublish = useCallback(async () => {
    if (!workflow) return;
    const next = !workflow.isActive;
    if (next && !hasTriggerNode) {
      toast.error('Add a trigger first.');
      return;
    }
    setPublishBusy(true);
    try {
      const { workflow: updated } = await updateWorkflowApi(workflowId, { isActive: next });
      setWorkflow((w) => ({ ...w, ...updated }));
      toast.success(next ? 'Workflow published' : 'Workflow set to draft');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setPublishBusy(false);
    }
  }, [workflow, hasTriggerNode, workflowId, toast]);

  // ─── Drag-and-drop from palette ──────────────────────────────────
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return; }
    const { type, kind } = payload || {};
    if (!type || !kind) return;

    // Single-trigger enforcement: a workflow has at most one trigger node in
    // v1. Reject extra trigger drops with a toast (palette doesn't grey out
    // because the rule lives on the canvas, not the source).
    if (type === 'trigger' && hasTriggerNode) {
      toast.error('Only one trigger per workflow. Delete the existing trigger first.');
      return;
    }
    const entry = findCatalogEntry(type, kind);
    if (!entry) return;

    // Compute drop position in flow coordinates. reactflow's
    // `screenToFlowPosition` is the canonical helper but only available via
    // useReactFlow(); for a v1 canvas the wrapper-relative offset is close
    // enough and avoids the extra hook plumbing.
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const position = bounds
      ? { x: e.clientX - bounds.left - 90, y: e.clientY - bounds.top - 25 }
      : { x: 200, y: 120 };

    try {
      const { node: serverNode } = await createNodeApi(workflowId, {
        type,
        kind,
        config: {},
        position,
      });
      setNodes((nds) => nds.concat(toRfNode(serverNode)));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [hasTriggerNode, workflowId, setNodes, toast]);

  // ─── Edge connect (user dragged from one handle to another) ────────
  const onConnect = useCallback(async (params) => {
    if (!params?.source || !params?.target) return;
    if (params.source === params.target) {
      toast.error('A node cannot connect to itself.');
      return;
    }
    const dup = edges.some((e) => e.source === params.source && e.target === params.target);
    if (dup) {
      toast.error('That connection already exists.');
      return;
    }

    // Phase W2 branching — when dragging out of a CONDITION node, auto-
    // assign the first connection as the "true" path and the second as
    // "false". Beyond two edges, leave branch null (engine treats null as
    // "always followed", so extra edges from a condition fall through).
    const sourceNode = nodes.find((n) => n.id === params.source);
    let branch;
    if (sourceNode?.type === 'condition') {
      const fromSource = edges.filter((e) => e.source === params.source).length;
      if (fromSource === 0) branch = 'true';
      else if (fromSource === 1) branch = 'false';
    }

    try {
      const { edge: serverEdge } = await createEdgeApi(workflowId, {
        sourceNodeId: params.source,
        targetNodeId: params.target,
        branch,
      });
      setEdges((eds) => addEdge(toRfEdge(serverEdge), eds));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [edges, nodes, workflowId, setEdges, toast]);

  // ─── Test run (Phase W2) ─────────────────────────────────────────
  const handleTestRun = useCallback(async () => {
    if (testRunBusy) return;
    setTestRunBusy(true);
    try {
      const { result } = await testRunWorkflowApi(workflowId);
      const summary = `Test run ${result?.status || 'ok'} — ${result?.nodesRun || 0} action(s) in ${result?.durationMs || 0}ms`;
      if (result?.status === 'error') {
        toast.error(summary);
      } else if (result?.status === 'partial') {
        toast.info(summary);
      } else {
        toast.success(summary);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setTestRunBusy(false);
    }
  }, [testRunBusy, workflowId, toast]);

  // ─── Position drag: debounce-PATCH per-node ───────────────────────
  const schedulePositionFlush = useCallback((nodeId, position) => {
    const timers = positionFlushTimers.current;
    if (timers[nodeId]) clearTimeout(timers[nodeId]);
    timers[nodeId] = setTimeout(async () => {
      delete timers[nodeId];
      try {
        await updateNodeApi(workflowId, nodeId, { position });
      } catch (err) {
        safeLog.warn('[WorkflowCanvasPage] node position save failed', err);
      }
    }, POSITION_DEBOUNCE_MS);
  }, [workflowId]);

  const onNodeDragStop = useCallback((_e, node) => {
    if (!node) return;
    schedulePositionFlush(node.id, node.position);
  }, [schedulePositionFlush]);

  // ─── Select / delete ─────────────────────────────────────────────
  const onNodeClick = useCallback((_e, node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const onNodesDelete = useCallback(async (deleted) => {
    for (const n of deleted) {
      try {
        await deleteNodeApi(workflowId, n.id);
        if (selectedNodeId === n.id) setSelectedNodeId(null);
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
  }, [workflowId, selectedNodeId, toast]);

  const onEdgesDelete = useCallback(async (deleted) => {
    for (const e of deleted) {
      try {
        await deleteEdgeApi(workflowId, e.id);
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
  }, [workflowId, toast]);

  // ─── Sidebar config save ─────────────────────────────────────────
  const handleConfigChange = useCallback(async ({ config }) => {
    if (!selectedNodeId) return;
    setSavingNode(true);
    try {
      const { node: updated } = await updateNodeApi(workflowId, selectedNodeId, { config });
      // Mirror back into reactflow state so the (currently invisible) node
      // body stays in sync if we ever surface config preview in the card.
      setNodes((nds) => nds.map((n) => (
        n.id === selectedNodeId
          ? { ...n, data: { ...n.data, config: updated?.config ?? config } }
          : n
      )));
      toast.success('Saved');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingNode(false);
    }
  }, [selectedNodeId, workflowId, setNodes, toast]);

  const handleSidebarDelete = useCallback(async () => {
    if (!selectedNodeId) return;
    const ok = window.confirm('Delete this node?');
    if (!ok) return;
    try {
      await deleteNodeApi(workflowId, selectedNodeId);
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [selectedNodeId, workflowId, setNodes, setEdges, toast]);

  // ─── Render ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <Loader2 size={20} className="animate-spin mr-2" /> Loading workflow…
      </div>
    );
  }

  if (loadError || !workflow) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertCircle size={48} className="text-text-tertiary" />}
          title="Couldn't load this workflow"
          description={loadError || 'The workflow may have been deleted or you may not have access.'}
          primaryAction={{ label: 'Back to workflows', onClick: () => navigate('/workflows') }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header
        className="flex items-center gap-2 px-4 py-2.5 bg-surface flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <button
          type="button"
          onClick={() => navigate('/workflows')}
          aria-label="Back to workflows"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#a855f7' }}
        >
          <WorkflowIcon size={13} />
        </span>

        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
              if (e.key === 'Escape') {
                setEditingTitle(false);
                setTitleDraft(workflow?.name || '');
              }
            }}
            maxLength={200}
            className="text-base font-bold text-text-primary bg-transparent border-b-2 border-primary outline-none flex-1 min-w-0"
          />
        ) : (
          <h1
            className="text-base font-bold text-text-primary hover:bg-surface-50 rounded px-1 -ml-1 cursor-text truncate"
            onClick={() => setEditingTitle(true)}
            title="Click to rename"
          >
            {workflow.name || 'Untitled workflow'}
          </h1>
        )}

        <StatusPill isActive={!!workflow.isActive} />

        <div className="ml-auto flex items-center gap-2">
          {/* Phase W2 — synthetic run from the canvas. Available regardless
              of publish state because the whole point is to dry-run before
              flipping the workflow live. */}
          <button
            type="button"
            onClick={() => setRunHistoryOpen(true)}
            data-testid="run-history-button"
            title="View recent runs of this workflow"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-border bg-surface text-text-secondary hover:bg-surface-100"
          >
            <History size={12} /> Run history
          </button>
          <button
            type="button"
            onClick={handleTestRun}
            disabled={testRunBusy}
            data-testid="test-run-button"
            title="Run this workflow once with a synthetic task to verify the canvas"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-border bg-surface text-text-secondary hover:bg-surface-100 disabled:opacity-60"
          >
            {testRunBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Test run
          </button>
          <button
            type="button"
            onClick={handleTogglePublish}
            disabled={publishBusy}
            data-testid="publish-toggle"
            aria-pressed={!!workflow.isActive}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-60 ${
              workflow.isActive
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                : 'bg-primary text-white hover:bg-primary-600'
            }`}
          >
            {publishBusy && <Loader2 size={12} className="animate-spin" />}
            {workflow.isActive ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </header>

      {/* ── Three-column body ───────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        <WorkflowNodePalette />

        <div
          ref={wrapperRef}
          className="flex-1 min-w-0 relative bg-surface-50"
          onDragOver={onDragOver}
          onDrop={onDrop}
          data-testid="canvas-wrapper"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            nodeTypes={NODE_TYPES}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>

          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto bg-surface border border-border-light rounded-lg px-4 py-3 shadow-sm text-center max-w-sm">
                <div className="text-sm font-semibold text-text-primary mb-1">Empty canvas</div>
                <p className="text-xs text-text-secondary">
                  Drag a trigger from the left palette to begin, then drop one or
                  more actions and connect them.
                </p>
              </div>
            </div>
          )}
        </div>

        {selectedNode && (
          <NodeConfigSidebar
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            onChange={handleConfigChange}
            onDelete={handleSidebarDelete}
            isSaving={savingNode}
          />
        )}
      </div>

      {/* Run history drawer — sibling of the layout so it covers everything
          including the palette + sidebar. Portal-rendered internally. */}
      <RunHistoryDrawer
        isOpen={runHistoryOpen}
        workflowId={workflowId}
        onClose={() => setRunHistoryOpen(false)}
      />
    </div>
  );
}

function StatusPill({ isActive }) {
  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-zinc-200 text-zinc-700">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" /> Draft
    </span>
  );
}
