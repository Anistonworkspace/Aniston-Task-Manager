const { TaskWatcher, User, Task } = require('../models');

// GET /api/tasks/:taskId/watchers
exports.getWatchers = async (req, res) => {
  try {
    const watchers = await TaskWatcher.findAll({
      where: { taskId: req.params.taskId },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar'] }],
    });
    res.json({ success: true, data: { watchers } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch watchers.' });
  }
};

// POST /api/tasks/:taskId/watch — toggle watch
exports.toggleWatch = async (req, res) => {
  try {
    const existing = await TaskWatcher.findOne({
      where: { taskId: req.params.taskId, userId: req.user.id },
    });

    if (existing) {
      await existing.destroy();
      return res.json({ success: true, data: { watching: false } });
    }

    await TaskWatcher.create({ taskId: req.params.taskId, userId: req.user.id });
    res.json({ success: true, data: { watching: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to toggle watch.' });
  }
};

// GET /api/tasks/:taskId/watching — check if current user is watching
exports.isWatching = async (req, res) => {
  try {
    const watcher = await TaskWatcher.findOne({
      where: { taskId: req.params.taskId, userId: req.user.id },
    });
    res.json({ success: true, data: { watching: !!watcher } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to check watch status.' });
  }
};
