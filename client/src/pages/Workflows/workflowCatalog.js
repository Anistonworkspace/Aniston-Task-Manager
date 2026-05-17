/**
 * workflowCatalog — declarative catalog of triggers + actions for the
 * Workflow Canvas (Phase W1).
 *
 * MUST be kept in sync with the server-side catalog so that a node "kind"
 * created here matches a known server-side handler when the workflow runs.
 * If you add a kind here, add the matching entry server-side and bump the
 * catalog version on both ends.
 *
 * Each entry shape:
 *   { kind: string,            // wire identifier — never change once shipped
 *     label: string,           // human title (palette + node card)
 *     description?: string,    // tooltip / palette subtitle
 *     comingSoon?: boolean,    // greys out drag + shows a pill in the palette
 *     configFields?: Array<{   // declarative form schema for NodeConfigSidebar
 *       key: string,           // config[key] write/read
 *       label: string,         // form label
 *       type: 'text'|'textarea'|'number'|'select'|'user',
 *       placeholder?: string,
 *       options?: string[],    // for type: 'select'
 *     }>,
 *   }
 *
 * The schema is intentionally tiny — v1 is "linear chain of one trigger to N
 * actions". Conditions, branches, loops, and per-field expression-language
 * support are scoped for v2; their UI is "coming soon" pills only.
 */

export const TRIGGERS = [
  {
    kind: 'task_created',
    label: 'When task is created',
    description: 'Fires when a new task is added on the board',
  },
  {
    kind: 'task_updated',
    label: 'When task is updated',
    description: 'Fires when any field changes',
  },
  {
    kind: 'status_changed',
    label: 'When status changes',
    description: 'Fires when status moves to/from a specific value',
    configFields: [
      { key: 'status', label: 'Status', type: 'text', placeholder: 'e.g. done' },
    ],
  },
  {
    kind: 'task_assigned',
    label: 'When task is assigned',
    description: 'Fires when assignee is set or changed',
  },
  {
    kind: 'form_submitted',
    label: 'When a form is submitted',
    description: 'Fires when any form in this workspace gets a submission',
    configFields: [
      {
        key: 'formId',
        label: 'Form (optional — leave empty to match any form)',
        type: 'form-picker',
        placeholder: 'Any form in the workspace',
      },
    ],
  },
];

export const ACTIONS = [
  {
    kind: 'notify_user',
    label: 'Notify a user',
    description: 'Send an in-app notification',
    configFields: [
      { key: 'userId', label: 'Recipient', type: 'user', placeholder: 'Pick a user or "assignee"' },
      { key: 'message', label: 'Message', type: 'textarea' },
    ],
  },
  {
    kind: 'change_status',
    label: 'Change task status',
    description: 'Set the task status to a value',
    configFields: [
      { key: 'to', label: 'New status', type: 'text', placeholder: 'e.g. done' },
    ],
  },
  {
    kind: 'change_priority',
    label: 'Change task priority',
    description: 'Set the priority to low / medium / high / critical',
    configFields: [
      { key: 'to', label: 'New priority', type: 'select', options: ['low', 'medium', 'high', 'critical'] },
    ],
  },
  {
    kind: 'assign_to',
    label: 'Assign to a user',
    configFields: [
      { key: 'userId', label: 'Assignee', type: 'user' },
    ],
  },
  {
    kind: 'send_message',
    label: 'Send Teams message',
    description: 'Post an Adaptive Card to the configured Teams webhook',
    configFields: [
      {
        key: 'text',
        label: 'Message',
        type: 'textarea',
        placeholder: 'e.g. Task "{{task.title}}" moved to {{task.status}}',
      },
    ],
  },
  {
    kind: 'wait',
    label: 'Wait',
    description: 'Pause the workflow before the next action (max 5 min in v2)',
    configFields: [
      { key: 'minutes', label: 'Minutes (capped at 5)', type: 'number' },
    ],
  },
];

// Phase W2 — condition catalog. A condition node evaluates a single
// (field, operator, value) tuple at run-time; the walker follows only the
// outgoing edge whose `branch` matches the result.
export const CONDITIONS = [
  {
    kind: 'condition_field',
    label: 'If task field matches',
    description: 'Branch on a task field value (status, priority, etc.)',
    configFields: [
      {
        key: 'field',
        label: 'Field',
        type: 'select',
        options: ['task.status', 'task.priority', 'task.assignedTo', 'task.dueDate'],
      },
      {
        key: 'operator',
        label: 'Operator',
        type: 'select',
        options: ['equals', 'not_equals', 'contains', 'is_set', 'is_empty'],
      },
      {
        key: 'value',
        label: 'Value (ignored for is_set / is_empty)',
        type: 'text',
        placeholder: 'e.g. done',
      },
    ],
  },
];

/**
 * Lookup helper — returns the catalog entry for a given (type, kind) pair.
 * `type` ∈ {'trigger','action'}. Returns null when no match (which the UI
 * uses to fall back to a "Unknown node" card so a future server-only kind
 * doesn't crash an old client.)
 */
export function findCatalogEntry(type, kind) {
  if (type === 'trigger') return TRIGGERS.find((t) => t.kind === kind) || null;
  if (type === 'action') return ACTIONS.find((a) => a.kind === kind) || null;
  if (type === 'condition') return CONDITIONS.find((c) => c.kind === kind) || null;
  return null;
}

export default { TRIGGERS, ACTIONS, CONDITIONS, findCatalogEntry };
