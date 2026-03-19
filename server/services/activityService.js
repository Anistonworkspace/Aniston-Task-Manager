const { Activity } = require('../models');

/**
 * Log an activity. Fire-and-forget — never blocks the response.
 *
 * @param {Object} opts
 * @param {string} opts.action       - e.g. 'task_created', 'status_changed'
 * @param {string} opts.description  - human-readable message
 * @param {string} opts.entityType   - 'task' | 'subtask' | 'worklog' | 'comment'
 * @param {string} opts.entityId     - UUID of the entity
 * @param {string} opts.taskId       - parent task UUID (nullable)
 * @param {string} opts.boardId      - board UUID (nullable)
 * @param {string} opts.userId       - who performed the action
 * @param {Object} [opts.meta]       - extra details
 */
function logActivity(opts) {
  Activity.create({
    action: opts.action,
    description: opts.description,
    entityType: opts.entityType,
    entityId: opts.entityId,
    taskId: opts.taskId || null,
    boardId: opts.boardId || null,
    userId: opts.userId,
    meta: opts.meta || {},
  }).catch(err => {
    console.error('[Activity] Failed to log activity:', err.message);
  });
}

module.exports = { logActivity };
