const { HierarchyLevel } = require('../models');

// GET /api/hierarchy-levels
exports.getAll = async (req, res) => {
  try {
    const levels = await HierarchyLevel.findAll({
      where: { isActive: true },
      order: [['order', 'ASC']],
    });
    res.json({ success: true, data: { levels } });
  } catch (err) {
    console.error('[HierarchyLevel] getAll error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch hierarchy levels.' });
  }
};

// POST /api/hierarchy-levels
exports.create = async (req, res) => {
  try {
    const { name, label, order, color, icon, description } = req.body;
    if (!name || !label) {
      return res.status(400).json({ success: false, message: 'name and label are required.' });
    }
    const maxOrder = await HierarchyLevel.max('order') || 0;
    const level = await HierarchyLevel.create({
      name, label, order: order ?? maxOrder + 1, color, icon, description,
    });
    res.status(201).json({ success: true, data: { level } });
  } catch (err) {
    console.error('[HierarchyLevel] create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create hierarchy level.' });
  }
};

// PUT /api/hierarchy-levels/:id
exports.update = async (req, res) => {
  try {
    const level = await HierarchyLevel.findByPk(req.params.id);
    if (!level) return res.status(404).json({ success: false, message: 'Level not found.' });
    const { name, label, order, color, icon, description, isActive } = req.body;
    await level.update({
      ...(name !== undefined && { name }),
      ...(label !== undefined && { label }),
      ...(order !== undefined && { order }),
      ...(color !== undefined && { color }),
      ...(icon !== undefined && { icon }),
      ...(description !== undefined && { description }),
      ...(isActive !== undefined && { isActive }),
    });
    res.json({ success: true, data: { level } });
  } catch (err) {
    console.error('[HierarchyLevel] update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update hierarchy level.' });
  }
};

// DELETE /api/hierarchy-levels/:id
exports.remove = async (req, res) => {
  try {
    const level = await HierarchyLevel.findByPk(req.params.id);
    if (!level) return res.status(404).json({ success: false, message: 'Level not found.' });
    await level.update({ isActive: false });
    res.json({ success: true, message: 'Level deactivated.' });
  } catch (err) {
    console.error('[HierarchyLevel] remove error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove hierarchy level.' });
  }
};

// PUT /api/hierarchy-levels/reorder
exports.reorder = async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, message: 'orderedIds array required.' });
    }
    await Promise.all(orderedIds.map((id, idx) =>
      HierarchyLevel.update({ order: idx }, { where: { id } })
    ));
    res.json({ success: true, message: 'Reordered.' });
  } catch (err) {
    console.error('[HierarchyLevel] reorder error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reorder.' });
  }
};
