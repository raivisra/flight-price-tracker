require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { apiLimiter, authLimiter } = require('./middleware/security.middleware');
const { verifyToken } = require('./middleware/auth.middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Helmet: Set security HTTP headers
app.use(helmet());

// CORS: Allow safe cross-origin requests
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourdomain.com'] // Whitelist production domains
    : 'http://localhost:3000',
  credentials: true
}));

// Logging
app.use(morgan('dev'));

// Body parser
app.use(express.json({ limit: '10kb' })); // Limit payload size

// Rate limiting
app.use('/api/', apiLimiter);

// ============================================
// PUBLIC ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API version
app.get('/api/version', (req, res) => {
  res.json({
    version: '0.1.0',
    services: {
      database: process.env.DB_HOST ? '✓' : '✗',
      llm: process.env.OLLAMA_HOST ? '✓' : '✗',
      travelpayouts: '✓'
    }
  });
});

// ============================================
// AUTH ROUTES
// ============================================

const authRoutes = require('./routes/auth');
app.use('/api/auth', authLimiter, authRoutes);

// ============================================
// PROTECTED ROUTES (require JWT token)
// ============================================

// Example protected route
app.get('/api/me', verifyToken, (req, res) => {
  res.json({
    message: 'Protected route',
    user_id: req.user.user_id
  });
});

// TODO: Add protected routes
// app.use('/api/searches', verifyToken, require('./routes/searches'));
// app.use('/api/prices', verifyToken, require('./routes/prices'));
// app.use('/api/insights', verifyToken, require('./routes/insights'));

// ============================================
// ERROR HANDLING
// ============================================

// 404 Not Found
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);

  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { details: err })
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  Flight Price Tracker API                  ║
╠════════════════════════════════════════════╣
║  Server:  http://localhost:${PORT}         ║
║  Env:     ${process.env.NODE_ENV || 'development'}                        ║
║  DB:      ${process.env.DB_HOST}:${process.env.DB_PORT}               ║
║  LLM:     ${process.env.OLLAMA_HOST}          ║
╠════════════════════════════════════════════╣
║  Endpoints:                                ║
║    /health                 (public)        ║
║    /api/auth/register      (public)        ║
║    /api/auth/login         (public)        ║
║    /api/me                 (protected)     ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
