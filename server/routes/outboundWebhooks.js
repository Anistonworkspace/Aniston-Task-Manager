const express = require('express');
const router = express.Router();
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const ctrl = require('../controllers/webhookController');

router.use(authenticate, strictAdminOnly);

router.post('/', ctrl.createWebhook);
router.get('/', ctrl.listWebhooks);
router.patch('/:id/toggle', ctrl.toggleWebhook);
router.delete('/:id', ctrl.deleteWebhook);
router.get('/:id/deliveries', ctrl.listDeliveries);
router.post('/:id/test', ctrl.testWebhook);

module.exports = router;
