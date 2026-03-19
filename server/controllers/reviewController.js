const PDFDocument = require('pdfkit');
const { Task, User, Board, WorkLog } = require('../models');
const { Op } = require('sequelize');

/**
 * Get the Monday and Sunday of the week containing `dateStr` (ISO string or Date).
 */
function getWeekRange(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay(); // 0=Sun
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    start: mon.toISOString().slice(0, 10),
    end: sun.toISOString().slice(0, 10),
    label: `${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
  };
}

/**
 * Fetch review data for a user for a given week
 */
async function fetchReviewData(userId, weekDate) {
  const { start, end, label } = getWeekRange(weekDate);

  const user = await User.findByPk(userId, {
    attributes: ['id', 'name', 'email', 'designation', 'department', 'role'],
  });

  // Tasks that were updated/completed this week
  const tasks = await Task.findAll({
    where: {
      assignedTo: userId,
      isArchived: false,
      updatedAt: { [Op.between]: [new Date(`${start}T00:00:00`), new Date(`${end}T23:59:59`)] },
    },
    include: [
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
    order: [['status', 'ASC'], ['updatedAt', 'DESC']],
  });

  // Work logs for this week
  const worklogs = await WorkLog.findAll({
    where: {
      userId,
      date: { [Op.between]: [start, end] },
    },
    include: [
      { model: Task, as: 'task', attributes: ['id', 'title'] },
    ],
    order: [['date', 'ASC'], ['createdAt', 'ASC']],
  });

  const summary = {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    working: tasks.filter(t => t.status === 'working_on_it').length,
    stuck: tasks.filter(t => t.status === 'stuck').length,
    notStarted: tasks.filter(t => t.status === 'not_started').length,
  };

  return { user, tasks, worklogs, summary, weekRange: { start, end, label } };
}

const STATUS_LABELS = {
  not_started: 'Not Started',
  working_on_it: 'Working On It',
  stuck: 'Stuck',
  done: 'Done',
  review: 'In Review',
};

const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Urgent',
};

/**
 * GET /api/reviews/weekly?date=YYYY-MM-DD&userId=...
 * Returns weekly review data as JSON
 */
const getWeeklyReview = async (req, res) => {
  try {
    const { date } = req.query;
    // Members can only see their own; managers can specify userId
    const userId = (req.user.role === 'member') ? req.user.id : (req.query.userId || req.user.id);

    const data = await fetchReviewData(userId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Review] getWeeklyReview error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching review.' });
  }
};

/**
 * GET /api/reviews/weekly/pdf?date=YYYY-MM-DD&userId=...
 */
const downloadPDF = async (req, res) => {
  try {
    const { date } = req.query;
    const userId = (req.user.role === 'member') ? req.user.id : (req.query.userId || req.user.id);
    const { user, tasks, worklogs, summary, weekRange } = await fetchReviewData(userId, date);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="review-${user.name.replace(/\s+/g, '_')}-${weekRange.start}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('Weekly Review Report', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text(weekRange.label, { align: 'center' });
    doc.moveDown(1);

    // User info
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#333333').text(user.name);
    const infoLine = [user.designation, user.department, user.email].filter(Boolean).join(' | ');
    if (infoLine) doc.fontSize(9).font('Helvetica').fillColor('#888888').text(infoLine);
    doc.moveDown(0.8);

    // Summary box
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text('Summary');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555555');
    doc.text(`Total Tasks: ${summary.total}    |    Done: ${summary.done}    |    Working: ${summary.working}    |    Stuck: ${summary.stuck}    |    Not Started: ${summary.notStarted}`);
    const completionRate = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
    doc.text(`Completion Rate: ${completionRate}%`);
    doc.moveDown(1);

    // Tasks table
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text('Tasks');
    doc.moveDown(0.3);

    if (tasks.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('No tasks updated this week.');
    } else {
      // Table header
      const tableTop = doc.y;
      const col = { title: 50, board: 280, status: 370, priority: 440, due: 510 };
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666');
      doc.text('Task', col.title, tableTop);
      doc.text('Board', col.board, tableTop);
      doc.text('Status', col.status, tableTop);
      doc.text('Priority', col.priority, tableTop);
      doc.text('Due', col.due, tableTop);
      doc.moveTo(50, tableTop + 12).lineTo(560, tableTop + 12).strokeColor('#dddddd').lineWidth(0.5).stroke();

      let y = tableTop + 18;
      tasks.forEach(t => {
        if (y > 750) { doc.addPage(); y = 50; }
        doc.fontSize(9).font('Helvetica').fillColor('#333333');
        doc.text(t.title.substring(0, 35), col.title, y, { width: 220 });
        doc.fontSize(8).fillColor('#888888');
        doc.text(t.board?.name || '—', col.board, y, { width: 80 });
        doc.text(STATUS_LABELS[t.status] || t.status, col.status, y, { width: 60 });
        doc.text(PRIORITY_LABELS[t.priority] || t.priority, col.priority, y, { width: 60 });
        doc.text(t.dueDate ? t.dueDate.toString().slice(0, 10) : '—', col.due, y, { width: 50 });
        y += 16;
      });
      doc.y = y;
    }

    doc.moveDown(1);

    // Work logs
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text('Daily Updates');
    doc.moveDown(0.3);

    if (worklogs.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('No daily updates this week.');
    } else {
      worklogs.forEach(log => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555').text(`${log.date} — ${log.task?.title || 'General'}`);
        doc.fontSize(9).font('Helvetica').fillColor('#666666').text(log.content, { indent: 10 });
        doc.moveDown(0.4);
      });
    }

    // Footer
    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica').fillColor('#aaaaaa').text(`Generated on ${new Date().toLocaleString()} — Aniston Project Hub`, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('[Review] downloadPDF error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Server error generating PDF.' });
    }
  }
};

/**
 * GET /api/reviews/weekly/csv?date=YYYY-MM-DD&userId=...
 */
const downloadCSV = async (req, res) => {
  try {
    const { date } = req.query;
    const userId = (req.user.role === 'member') ? req.user.id : (req.query.userId || req.user.id);
    const { user, tasks, worklogs, weekRange } = await fetchReviewData(userId, date);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="review-${user.name.replace(/\s+/g, '_')}-${weekRange.start}.csv"`);

    const escape = (str) => `"${(str || '').replace(/"/g, '""')}"`;
    const lines = [];

    lines.push('Weekly Review Report');
    lines.push(`Employee,${escape(user.name)}`);
    lines.push(`Week,${escape(weekRange.label)}`);
    lines.push('');

    // Tasks
    lines.push('TASKS');
    lines.push('Title,Board,Status,Priority,Due Date');
    tasks.forEach(t => {
      lines.push([
        escape(t.title),
        escape(t.board?.name || ''),
        escape(STATUS_LABELS[t.status] || t.status),
        escape(PRIORITY_LABELS[t.priority] || t.priority),
        escape(t.dueDate ? t.dueDate.toString().slice(0, 10) : ''),
      ].join(','));
    });

    lines.push('');

    // Work logs
    lines.push('DAILY UPDATES');
    lines.push('Date,Task,Content');
    worklogs.forEach(log => {
      lines.push([
        escape(log.date),
        escape(log.task?.title || ''),
        escape(log.content),
      ].join(','));
    });

    res.send(lines.join('\r\n'));
  } catch (error) {
    console.error('[Review] downloadCSV error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Server error generating CSV.' });
    }
  }
};

module.exports = { getWeeklyReview, downloadPDF, downloadCSV };
