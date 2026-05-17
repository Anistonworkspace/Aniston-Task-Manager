'use strict';

/**
 * Doc Editor Phase G — REST surface for the real-time collab subsystem.
 *
 * Today: a single ticket endpoint that mints a 60s JWT the browser uses
 * to authenticate the `/api/docs-collab/ws` WebSocket upgrade. Mirrors
 * the meeting-stream ticket pattern.
 *
 * The ticket binds the caller to a specific docId, so a token minted for
 * doc A cannot be replayed against doc B. The purpose claim
 * (`doc-collab-ws`) means a regular access JWT or a meeting-stream
 * ticket cannot be smuggled in either direction.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');
const { Doc, Workspace, User } = require('../models');
const { canSeeWorkspace, TICKET_PURPOSE } = require('../services/docCollabService');
const safeLogger = require('../utils/safeLogger');

const router = express.Router();

const TICKET_TTL_SECONDS = 60;

/**
 * POST /api/docs-collab/ticket
 *
 * Body: { docId }
 *
 * Returns: { success: true, data: { ticket, expiresIn } } — a 60s JWT
 * signed with `{ id, docId, purpose: 'doc-collab-ws', role, isSuperAdmin }`.
 *
 * 400 — missing docId
 * 403 — caller cannot see the doc's workspace, or doc archived
 * 404 — doc not found
 */
router.post('/ticket', authenticate, async (req, res) => {
  try {
    const docId = req.body && req.body.docId;
    if (!docId || typeof docId !== 'string') {
      return res.status(400).json({ success: false, message: 'docId is required.' });
    }

    const doc = await Doc.findByPk(docId);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Doc not found.' });
    }
    if (doc.isArchived) {
      return res.status(403).json({ success: false, message: 'This doc is archived.' });
    }

    const visible = await canSeeWorkspace({ Workspace, User }, req.user, doc.workspaceId);
    if (!visible) {
      return res.status(403).json({ success: false, message: 'You do not have access to this doc.' });
    }

    const ticket = jwt.sign(
      {
        id: req.user.id,
        docId,
        purpose: TICKET_PURPOSE,
        role: req.user.role,
        isSuperAdmin: !!req.user.isSuperAdmin,
      },
      process.env.JWT_SECRET,
      { expiresIn: `${TICKET_TTL_SECONDS}s` }
    );

    return res.json({
      success: true,
      data: { ticket, expiresIn: TICKET_TTL_SECONDS },
    });
  } catch (err) {
    safeLogger.error('[DocCollab] ticket error', { err, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Failed to issue collab ticket.' });
  }
});

module.exports = router;
