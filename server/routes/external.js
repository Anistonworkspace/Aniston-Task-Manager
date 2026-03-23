const express = require('express');
const router = express.Router();
const { apiKeyOrJwt } = require('../middleware/apiKeyAuth');
const { getAllEmployees, getEmployeeById } = require('../controllers/externalController');

// All external routes require API Key or JWT authentication
router.use(apiKeyOrJwt);

// GET /api/external/employees — List all employees (paginated, filterable)
router.get('/employees', getAllEmployees);

// GET /api/external/employees/:id — Get single employee by ID
router.get('/employees/:id', getEmployeeById);

module.exports = router;
