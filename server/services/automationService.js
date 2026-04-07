const { Automation, Task, User, Notification, Board } = require('../models');
const { emitToUser } = require('./socketService');

/**
 * Process automations when a trigger event occurs.
 * @param {string} trigger - The trigger type
 * @param {object} context - { task, board, userId, previousStatus, newStatus, etc. }
 */
async function processAutomations(trigger, context) {
  try {
    const { task } = context;
    if (!task?.boardId) return;

    const automations = await Automation.findAll({
      where: { boardId: task.boardId, trigger, isActive: true },
    });

    for (const auto of automations) {
      try {
        // Check trigger condition
        if (!matchesTrigger(auto, trigger, context)) continue;
        // Execute action
        await executeAction(auto, context);
      } catch (err) {
        console.error(`[Automation] Failed to execute "${auto.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[Automation] processAutomations error:', err);
  }
}

function matchesTrigger(auto, trigger, context) {
  switch (trigger) {
    case 'status_changed':
      // If triggerValue is set, only match that specific status
      if (auto.triggerValue && context.newStatus !== auto.triggerValue) return false;
      return true;
    case 'task_created':
    case 'task_assigned':
    case 'task_moved':
      return true;
    case 'due_date_arrived':
      return true;
    default:
      return true;
  }
}

async function executeAction(auto, context) {
  const { task } = context;
  const config = auto.actionConfig || {};

  switch (auto.action) {
    case 'notify_user': {
      const targetId = config.targetUserId || task.assignedTo || task.createdBy;
      if (!targetId) break;
      const msg = config.notifyMessage || `Automation "${auto.name}" triggered for "${task.title}"`;
      const notification = await Notification.create({
        type: 'task_updated', message: msg,
        entityType: 'task', entityId: task.id, userId: targetId,
      });
      emitToUser(targetId, 'notification:new', { notification });
      break;
    }
    case 'change_status': {
      if (config.targetStatus) {
        await Task.update({ status: config.targetStatus }, { where: { id: task.id } });
      }
      break;
    }
    case 'change_priority': {
      if (config.targetPriority) {
        await Task.update({ priority: config.targetPriority }, { where: { id: task.id } });
      }
      break;
    }
    case 'move_to_group': {
      if (config.targetGroupId) {
        await Task.update({ groupId: config.targetGroupId }, { where: { id: task.id } });
      }
      break;
    }
    case 'assign_to': {
      if (config.targetUserId) {
        await Task.update({ assignedTo: config.targetUserId }, { where: { id: task.id } });
        const notification = await Notification.create({
          type: 'task_assigned',
          message: `Auto-assigned: "${task.title}" (automation: ${auto.name})`,
          entityType: 'task', entityId: task.id, userId: config.targetUserId,
        });
        emitToUser(config.targetUserId, 'notification:new', { notification });
      }
      break;
    }
    case 'send_notification': {
      // Notify all board members or specific user
      const msg = config.notifyMessage || `"${task.title}" triggered automation "${auto.name}"`;
      if (config.targetUserId) {
        const n = await Notification.create({
          type: 'task_updated', message: msg,
          entityType: 'task', entityId: task.id, userId: config.targetUserId,
        });
        emitToUser(config.targetUserId, 'notification:new', { notification: n });
      }
      break;
    }
  }
}

module.exports = { processAutomations };
