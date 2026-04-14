const PDFDocument = require('pdfkit');
const { Task, User, Board, WorkLog } = require('../models');
const { Op } = require('sequelize');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');

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
    label: `${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
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
    order: buildPendingPriorityOrder(),
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

    // ── Helper: draw a positioned table row without corrupting PDFKit state ──
    // PDFKit's doc.text(str, x, y, opts) updates internal cursor (doc.x, doc.y,
    // and _wrapper width) after every call.  For multi-column rows we must use
    // lineBreak:false on all but the last column so that internal state stays sane.
    const PAGE_BOTTOM = 740;
    const LEFT = 50;
    const RIGHT = 560;
    const USABLE_W = RIGHT - LEFT; // 510

    // Tasks table
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text('Tasks', LEFT, doc.y, { width: USABLE_W });
    doc.moveDown(0.3);

    if (tasks.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('No tasks updated this week.', LEFT, doc.y, { width: USABLE_W });
    } else {
      const tableTop = doc.y;
      const col  = { title: 50, board: 280, status: 370, priority: 440, due: 510 };
      const colW = { title: 220, board: 80, status: 60, priority: 60, due: 50 };

      // Header row
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666');
      doc.text('Task',     col.title,    tableTop, { width: colW.title,    lineBreak: false });
      doc.text('Board',    col.board,    tableTop, { width: colW.board,    lineBreak: false });
      doc.text('Status',   col.status,   tableTop, { width: colW.status,   lineBreak: false });
      doc.text('Priority', col.priority, tableTop, { width: colW.priority, lineBreak: false });
      doc.text('Due',      col.due,      tableTop, { width: colW.due }); // last col: allow lineBreak to advance y
      doc.moveTo(LEFT, tableTop + 12).lineTo(RIGHT, tableTop + 12).strokeColor('#dddddd').lineWidth(0.5).stroke();

      let y = tableTop + 18;
      tasks.forEach(t => {
        if (y > PAGE_BOTTOM) { doc.addPage(); y = 50; }
        doc.fontSize(9).font('Helvetica').fillColor('#333333');
        doc.text(t.title.substring(0, 35), col.title, y, { width: colW.title, lineBreak: false });
        doc.fontSize(8).fillColor('#888888');
        doc.text(t.board?.name || '—',                  col.board,    y, { width: colW.board,    lineBreak: false });
        doc.text(STATUS_LABELS[t.status] || t.status,   col.status,   y, { width: colW.status,   lineBreak: false });
        doc.text(PRIORITY_LABELS[t.priority] || t.priority, col.priority, y, { width: colW.priority, lineBreak: false });
        doc.text(t.dueDate ? t.dueDate.toString().slice(0, 10) : '—', col.due, y, { width: colW.due });
        y += 16;
      });

      // ── Reset PDFKit internal cursor after absolute-positioned table ──
      // Render a full-width space to flush the internal _wrapper width back to
      // 510px.  A truly empty string '' is a no-op in PDFKit and does NOT reset.
      doc.x = LEFT;
      doc.y = y;
      doc.fontSize(1).fillColor('#ffffff').text(' ', LEFT, y, { width: USABLE_W });
      doc.fillColor('#333333');
    }

    // ── Daily Updates section ─────────────────────────────────────────────
    // Ensure we have room; if close to bottom, start a new page.
    if (doc.y > PAGE_BOTTOM - 60) { doc.addPage(); doc.x = LEFT; doc.y = 50; }

    doc.y += 14; // spacing after tasks
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text('Daily Updates', LEFT, doc.y, { width: USABLE_W });
    doc.y += 18;

    if (worklogs.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('No daily updates this week.', LEFT, doc.y, { width: USABLE_W });
    } else {
      // Column layout — full page width
      const logCol  = { date: 50, task: 150, content: 310 };
      const logColW = { date: 90, task: 150, content: 250 };

      // Table header
      const logTop = doc.y;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666');
      doc.text('Date',   logCol.date,    logTop, { width: logColW.date,    lineBreak: false });
      doc.text('Task',   logCol.task,    logTop, { width: logColW.task,    lineBreak: false });
      doc.text('Update', logCol.content, logTop, { width: logColW.content });
      doc.moveTo(LEFT, logTop + 12).lineTo(RIGHT, logTop + 12).strokeColor('#dddddd').lineWidth(0.5).stroke();

      let logY = logTop + 18;
      worklogs.forEach(log => {
        const cleanContent = (log.content || '').replace(/[\r\n]+/g, ' ').trim() || '—';
        const contentH = doc.fontSize(8).font('Helvetica').heightOfString(cleanContent, { width: logColW.content });
        const rowH = Math.max(contentH, 14) + 6;

        if (logY + rowH > PAGE_BOTTOM) {
          doc.addPage();
          logY = 50;
          // Re-draw header on new page
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666');
          doc.text('Date',   logCol.date,    logY, { width: logColW.date,    lineBreak: false });
          doc.text('Task',   logCol.task,    logY, { width: logColW.task,    lineBreak: false });
          doc.text('Update', logCol.content, logY, { width: logColW.content });
          doc.moveTo(LEFT, logY + 12).lineTo(RIGHT, logY + 12).strokeColor('#dddddd').lineWidth(0.5).stroke();
          logY += 18;
        }

        doc.fontSize(9).font('Helvetica').fillColor('#333333');
        doc.text(log.date || '',                                logCol.date,    logY, { width: logColW.date,    lineBreak: false });
        doc.text((log.task?.title || 'General').substring(0, 30), logCol.task,  logY, { width: logColW.task,    lineBreak: false });
        doc.fontSize(8).fillColor('#555555');
        doc.text(cleanContent,                                  logCol.content, logY, { width: logColW.content });

        // Light row separator
        doc.moveTo(LEFT, logY + rowH - 2).lineTo(RIGHT, logY + rowH - 2).strokeColor('#eeeeee').lineWidth(0.3).stroke();
        logY += rowH;
      });

      // Reset cursor after table
      doc.x = LEFT;
      doc.y = logY;
    }

    // Footer
    doc.y += 14;
    if (doc.y > PAGE_BOTTOM) { doc.addPage(); doc.y = 50; }
    doc.fontSize(8).font('Helvetica').fillColor('#aaaaaa').text(
      `Generated on ${new Date().toLocaleString()} — Monday Aniston`,
      LEFT, doc.y, { width: USABLE_W, align: 'center' }
    );

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
    const { user, tasks, worklogs, summary, weekRange } = await fetchReviewData(userId, date);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="review-${user.name.replace(/\s+/g, '_')}-${weekRange.start}.csv"`);

    // Sanitize a value for CSV: escape quotes, strip line breaks, replace unicode dashes
    const sanitize = (val) => {
      let str = (val == null ? '' : String(val));
      str = str.replace(/[\u2013\u2014]/g, '-');  // en-dash/em-dash → plain dash
      str = str.replace(/[\r\n]+/g, ' ').trim();  // collapse line breaks
      return str;
    };
    // CSV-escape: only quote if the value contains comma, quote, or whitespace
    const csvField = (val) => {
      const str = sanitize(val);
      if (str.includes(',') || str.includes('"') || str.includes('\r') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const completionRate = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;

    const lines = [];

    // Header
    lines.push('Weekly Review Report');
    lines.push(`Employee,${csvField(user.name)}`);
    lines.push(`Week,${csvField(sanitize(weekRange.label))}`);
    lines.push('');

    // Summary
    lines.push('Summary');
    lines.push(`Total Tasks,${summary.total}`);
    lines.push(`Done,${summary.done}`);
    lines.push(`Working,${summary.working}`);
    lines.push(`Stuck,${summary.stuck}`);
    lines.push(`Not Started,${summary.notStarted}`);
    lines.push(`Completion Rate,${completionRate}%`);
    lines.push('');

    // Tasks
    lines.push('Tasks');
    lines.push('Title,Board,Status,Priority,Due Date');
    tasks.forEach(t => {
      lines.push([
        csvField(t.title),
        csvField(t.board?.name || ''),
        csvField(STATUS_LABELS[t.status] || t.status),
        csvField(PRIORITY_LABELS[t.priority] || t.priority),
        csvField(t.dueDate ? t.dueDate.toString().slice(0, 10) : ''),
      ].join(','));
    });
    lines.push('');

    // Work logs
    lines.push('Daily Updates');
    lines.push('Date,Task,Content');
    worklogs.forEach(log => {
      lines.push([
        csvField(log.date),
        csvField(log.task?.title || ''),
        csvField(log.content),
      ].join(','));
    });

    // UTF-8 BOM + content as Buffer — ensures Excel recognizes encoding and column separation
    const csvContent = '\uFEFF' + lines.join('\r\n');
    const buffer = Buffer.from(csvContent, 'utf-8');
    res.end(buffer);
  } catch (error) {
    console.error('[Review] downloadCSV error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Server error generating CSV.' });
    }
  }
};

module.exports = { getWeeklyReview, downloadPDF, downloadCSV };
