const { Op } = require('sequelize');
const { Feedback, User } = require('../models');
const { sanitizeInput } = require('../utils/sanitize');

// POST /api/feedback — submit feedback (all authenticated users)
exports.submitFeedback = async (req, res) => {
  try {
    const { category, rating, message, page } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });
    }

    const feedback = await Feedback.create({
      category: category || 'other',
      rating,
      message: sanitizeInput(message),
      page: page || '',
      userId: req.user.id,
    });

    const full = await Feedback.findByPk(feedback.id, {
      include: [{ model: User, as: 'submitter', attributes: ['id', 'name', 'email', 'avatar'] }],
    });

    res.status(201).json({ success: true, data: { feedback: full } });
  } catch (err) {
    console.error('[FeedbackController] submitFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit feedback.' });
  }
};

// GET /api/feedback — list all feedback (admin only)
exports.getAllFeedback = async (req, res) => {
  try {
    const { category, status, rating, page = 1, limit = 20 } = req.query;
    const where = {};
    if (category) where.category = category;
    if (status) where.status = status;
    if (rating) where.rating = parseInt(rating);

    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const offset = (parseInt(page) - 1) * safeLimit;
    const { count, rows } = await Feedback.findAndCountAll({
      where,
      include: [{ model: User, as: 'submitter', attributes: ['id', 'name', 'email', 'avatar'] }],
      order: [['createdAt', 'DESC']],
      limit: safeLimit,
      offset,
    });

    res.json({
      success: true,
      data: {
        feedback: rows,
        total: count,
        page: parseInt(page),
        totalPages: Math.ceil(count / safeLimit),
      },
    });
  } catch (err) {
    console.error('[FeedbackController] getAllFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch feedback.' });
  }
};

// PUT /api/feedback/:id — update status/adminNotes (admin only)
exports.updateFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) return res.status(404).json({ success: false, message: 'Feedback not found.' });

    const { status, adminNotes } = req.body;
    if (status !== undefined) feedback.status = status;
    if (adminNotes !== undefined) feedback.adminNotes = sanitizeInput(adminNotes);

    await feedback.save();

    const full = await Feedback.findByPk(feedback.id, {
      include: [{ model: User, as: 'submitter', attributes: ['id', 'name', 'email', 'avatar'] }],
    });

    res.json({ success: true, data: { feedback: full } });
  } catch (err) {
    console.error('[FeedbackController] updateFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to update feedback.' });
  }
};

// DELETE /api/feedback/:id — delete (admin only)
exports.deleteFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) return res.status(404).json({ success: false, message: 'Feedback not found.' });

    await feedback.destroy();
    res.json({ success: true, message: 'Feedback deleted.' });
  } catch (err) {
    console.error('[FeedbackController] deleteFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete feedback.' });
  }
};

// GET /api/feedback/stats — feedback statistics (admin only)
exports.getFeedbackStats = async (req, res) => {
  try {
    const { sequelize } = require('../config/db');

    const totalCount = await Feedback.count();
    const avgRatingResult = await Feedback.findOne({
      attributes: [[sequelize.fn('AVG', sequelize.col('rating')), 'avgRating']],
      raw: true,
    });

    const byCategory = await Feedback.findAll({
      attributes: ['category', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['category'],
      raw: true,
    });

    const byStatus = await Feedback.findAll({
      attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['status'],
      raw: true,
    });

    const byRating = await Feedback.findAll({
      attributes: ['rating', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['rating'],
      order: [['rating', 'ASC']],
      raw: true,
    });

    res.json({
      success: true,
      data: {
        total: totalCount,
        avgRating: parseFloat(avgRatingResult?.avgRating || 0).toFixed(1),
        byCategory,
        byStatus,
        byRating,
      },
    });
  } catch (err) {
    console.error('[FeedbackController] getFeedbackStats error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch feedback stats.' });
  }
};
