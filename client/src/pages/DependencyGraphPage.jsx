import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Network, AlertCircle, Loader2, ArrowLeft } from 'lucide-react';
import api from '../services/api';
import safeLog from '../utils/safeLog';
import { getErrorMessage } from '../utils/errorMap';
import EmptyState from '../components/common/EmptyState';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';

/**
 * DependencyGraphPage — visual DAG of task → task dependency links.
 *
 * Route: /dependencies/graph
 *
 * Data: GET /api/dependencies/graph → { nodes, edges } already shaped for
 * reactflow consumption (server returns task summaries as nodes + edges with
 * source/target task IDs). Visibility-scoped server-side.
 *
 * Layout: simple deterministic columnar layout based on each node's depth
 * in the DAG (BFS from roots). Tasks with no dependents go in column 0,
 * those that depend only on column-0 tasks go in column 1, and so on.
 * Cycles fall through into the highest column they reach — reactflow
 * happily renders them as back-edges.
 *
 * Click a node → open its board / task.
 */

const NODE_WIDTH = 220;
const NODE_H_SPACING = 60;
const NODE_V_SPACING = 24;
const NODE_HEIGHT = 78;

// ── reactflow node renderer ───────────────────────────────────────────
function TaskGraphNode({ data, selected }) {
  const statusCfg = STATUS_CONFIG[data.status] || {};
  const prioCfg = PRIORITY_CONFIG[data.priority] || {};
  return (
    <div
      className={`rounded-md shadow-sm border-2 bg-white px-2.5 py-2 ${
        selected ? 'border-primary' : 'border-border-light'
      }`}
      style={{
        width: NODE_WIDTH,
        boxShadow: selected ? '0 4px 14px rgba(59,130,246,0.25)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
      <div className="flex items-start gap-2">
        <span
          className="w-2 h-12 rounded-sm flex-shrink-0"
          style={{ backgroundColor: data.boardColor || '#94a3b8' }}
          title={data.boardName || ''}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-text-primary truncate">{data.title}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {data.status && (
              <span
                className="inline-block text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded text-white"
                style={{ backgroundColor: statusCfg.bgColor || '#94a3b8' }}
              >
                {statusCfg.label || data.status}
              </span>
            )}
            {data.priority && (
              <span
                className="inline-block text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: (prioCfg.bgColor || '#94a3b8') + '20',
                  color: prioCfg.bgColor || '#475569',
                }}
              >
                {prioCfg.label || data.priority}
              </span>
            )}
          </div>
          {data.assigneeName && (
            <div className="text-[10px] text-text-tertiary truncate mt-0.5">{data.assigneeName}</div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
    </div>
  );
}

const NODE_TYPES = { task: TaskGraphNode };

// ── Deterministic columnar layout. Source = "depends on", target = "is a
// prerequisite for". Prereqs (target-only nodes) go LEFT; dependents go RIGHT.
function computeLayout(rawNodes, rawEdges) {
  // Adjacency: for each node id, who it depends on (incoming targets).
  const incoming = new Map();
  const outgoing = new Map();
  for (const n of rawNodes) {
    incoming.set(n.id, new Set());
    outgoing.set(n.id, new Set());
  }
  for (const e of rawEdges) {
    // server edge: source depends on target → target is upstream of source.
    // Layout: upstream nodes left, downstream right.
    // depth(node) = 1 + max(depth(upstream)).
    outgoing.get(e.target)?.add(e.source);
    incoming.get(e.source)?.add(e.target);
  }

  // BFS from roots (nodes with no upstream) to assign depth. Cap iterations
  // so a cycle can't loop forever.
  const depth = new Map(rawNodes.map((n) => [n.id, 0]));
  const queue = rawNodes.filter((n) => incoming.get(n.id).size === 0).map((n) => n.id);
  let iterations = 0;
  const maxIterations = rawNodes.length * rawNodes.length;
  while (queue.length && iterations++ < maxIterations) {
    const id = queue.shift();
    for (const child of outgoing.get(id) || []) {
      const next = (depth.get(id) || 0) + 1;
      if (next > (depth.get(child) || 0)) {
        depth.set(child, next);
        queue.push(child);
      }
    }
  }

  // Bucket by depth, then position by index within each column.
  const buckets = new Map();
  for (const n of rawNodes) {
    const d = depth.get(n.id) || 0;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(n);
  }

  const positioned = [];
  Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([d, nodes]) => {
      nodes.forEach((n, i) => {
        positioned.push({
          id: n.id,
          type: 'task',
          position: {
            x: d * (NODE_WIDTH + NODE_H_SPACING),
            y: i * (NODE_HEIGHT + NODE_V_SPACING),
          },
          data: n,
        });
      });
    });
  return positioned;
}

function toRfEdges(rawEdges) {
  return rawEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.type === 'blocks' ? 'blocks' : e.type === 'related' ? 'related' : '',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    style: { stroke: '#94a3b8' },
    labelStyle: { fontSize: 10, fill: '#64748b' },
  }));
}

export default function DependencyGraphPage() {
  return (
    <ReactFlowProvider>
      <DependencyGraphInner />
    </ReactFlowProvider>
  );
}

function DependencyGraphInner() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialBoardId = searchParams.get('boardId') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [boardFilter, setBoardFilter] = useState(initialBoardId);
  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (boardFilter) params.boardId = boardFilter;
      const res = await api.get('/dependencies/graph', { params });
      const payload = res.data?.data || res.data || {};
      setRawNodes(Array.isArray(payload.nodes) ? payload.nodes : []);
      setRawEdges(Array.isArray(payload.edges) ? payload.edges : []);
    } catch (err) {
      safeLog.error('[DependencyGraphPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [boardFilter]);

  useEffect(() => { load(); }, [load]);

  // Re-derive reactflow node/edge shape whenever the raw payload changes.
  useEffect(() => {
    setNodes(computeLayout(rawNodes, rawEdges));
    setEdges(toRfEdges(rawEdges));
  }, [rawNodes, rawEdges, setNodes, setEdges]);

  const onNodeClick = useCallback((_event, node) => {
    const boardId = node.data?.boardId;
    if (boardId) navigate(`/boards/${boardId}`);
  }, [navigate]);

  const boardOptions = useMemo(() => {
    const map = new Map();
    for (const n of rawNodes) {
      if (n.boardId && !map.has(n.boardId)) {
        map.set(n.boardId, { id: n.boardId, name: n.boardName || 'Untitled', color: n.boardColor });
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [rawNodes]);

  function handleBoardChange(id) {
    setBoardFilter(id);
    if (id) setSearchParams({ boardId: id });
    else setSearchParams({});
  }

  return (
    <div className="flex flex-col h-full">
      <header
        className="flex items-center gap-2 px-4 py-2.5 bg-surface flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <button
          type="button"
          onClick={() => navigate('/cross-team')}
          aria-label="Back to dependencies"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}
        >
          <Network size={13} />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold text-text-primary truncate">Dependency graph</h1>
          <p className="text-[11px] text-text-tertiary truncate">
            {rawNodes.length} task{rawNodes.length === 1 ? '' : 's'} · {rawEdges.length} dependenc{rawEdges.length === 1 ? 'y' : 'ies'}
            {' — arrows point from a task to its prerequisite.'}
          </p>
        </div>

        {boardOptions.length > 0 && (
          <select
            value={boardFilter}
            onChange={(e) => handleBoardChange(e.target.value)}
            className="px-2.5 py-1 text-xs border border-border rounded-md bg-surface text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          >
            <option value="">All boards</option>
            {boardOptions.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
      </header>

      <div className="flex-1 min-h-0 relative bg-surface-50">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> Loading dependencies…
          </div>
        ) : error ? (
          <div className="p-6">
            <EmptyState
              icon={<AlertCircle size={48} className="text-text-tertiary" />}
              title="Couldn't load dependencies"
              description={error}
              primaryAction={{ label: 'Retry', onClick: load }}
            />
          </div>
        ) : rawNodes.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Network size={48} className="text-text-tertiary" />}
              title="No dependencies yet"
              description="When you link tasks via 'Blocked by' / 'Required for', this view will show the chain."
              primaryAction={{ label: 'Back to dependencies', onClick: () => navigate('/cross-team') }}
            />
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={NODE_TYPES}
            fitView
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
