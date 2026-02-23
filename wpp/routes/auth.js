// routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');  // Add this line

// Public routes (no auth required)
router.post('/register', authController.register);
router.post('/login', authController.login);

// Protected routes (auth required)
router.get('/system-prompt', authMiddleware, authController.getSystemPrompt);
router.post('/system-prompt', authMiddleware, authController.updateSystemPrompt);

module.exports = router;