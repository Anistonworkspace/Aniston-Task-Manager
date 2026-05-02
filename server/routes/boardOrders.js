const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getMine } = require('../controllers/boardOrderController');

const router = express.Router();

router.use(authenticate);

// GET /api/board-orders/mine — caller's full ordering map across all
// workspaces. Bulk endpoint used by the sidebar to apply per-user ordering
// in a single request. The per-workspace get/set endpoints live on the
// workspaces router (/api/workspaces/:id/board-order) to match the
// existing /api/workspaces/:id/* URL convention.
router.get('/mine', getMine);

module.exports = router;
