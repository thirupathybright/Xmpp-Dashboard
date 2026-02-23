// controllers/authController.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// Register Controller
exports.register = async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    db.query(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword],
      (err, result) => {
        if (err) {
          return res.status(500).json({ message: 'Register failed', error: err.message });
        }
        res.json({ message: 'Registered successfully' });
      }
    );
  } catch (error) {
    res.status(500).json({ message: 'Error hashing password', error: error.message });
  }
};

// Login Controller
exports.login = (req, res) => {
  const { email, password } = req.body;

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, result) => {
    if (err || result.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result[0];
    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, name: user.name || 'Guest' }, 'secret_key', {
      expiresIn: '7d',
    });

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name || 'Guest',
        email: user.email
      }
    });
  });
};

// Get System Prompt
exports.getSystemPrompt = (req, res) => {
  // req.user is set by authMiddleware
  const userId = req.user.id;
  
  if (!userId) {
    return res.status(401).json({
      status: 'error',
      message: 'User not authenticated'
    });
  }

  db.query('SELECT system_prompt FROM users WHERE id = ?', [userId], (err, results) => {
    if (err) {
      return res.status(500).json({ 
        status: 'error', 
        message: 'Failed to fetch system prompt',
        error: err.message 
      });
    }
    
    if (!results || results.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    res.json({ 
      status: 'success',
      system_prompt: results[0].system_prompt || null
    });
  });
};

// Update System Prompt
exports.updateSystemPrompt = (req, res) => {
  const userId = req.user.id;
  const { system_prompt } = req.body;
  
  if (!userId) {
    return res.status(401).json({
      status: 'error',
      message: 'User not authenticated'
    });
  }

  if (!system_prompt || system_prompt.trim().length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'System prompt cannot be empty'
    });
  }

  db.query(
    'UPDATE users SET system_prompt = ? WHERE id = ?',
    [system_prompt, userId],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to update system prompt',
          error: err.message
        });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }
      
      res.json({
        status: 'success',
        message: 'System prompt updated successfully'
      });
    }
  );
};