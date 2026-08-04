const express = require('express');
const router = express.Router();
const AuthService = require('../services/auth.service');

// ============================================
// REGISTER - POST /auth/register
// ============================================

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, password_confirm } = req.body;
    const { user, token } = await AuthService.register(username, email, password, password_confirm);

    res.status(201).json({
      message: 'User registered successfully',
      user,
      token
    });
  } catch (error) {
    const status = error.status || 500;
    const message = error.message || 'Registration failed';
    console.error('Register error:', error);
    res.status(status).json({ error: message });
  }
});

// ============================================
// LOGIN - POST /auth/login
// ============================================

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await AuthService.login(email, password);

    res.json({
      message: 'Login successful',
      ...result
    });
  } catch (error) {
    const status = error.status || 500;
    const message = error.message || 'Login failed';
    console.error('Login error:', error);
    res.status(status).json({ error: message });
  }
});

// ============================================
// VERIFY TOKEN - POST /auth/verify
// ============================================

router.post('/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = AuthService.verifyToken(token);
    res.json({ valid: true, user_id: decoded.user_id });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

// ============================================
// LOGOUT - POST /auth/logout (frontend removes token)
// ============================================

router.post('/logout', (req, res) => {
  const result = AuthService.logout();
  res.json(result);
});

module.exports = router;
