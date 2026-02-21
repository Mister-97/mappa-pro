require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');
const accountsRoutes = require('./routes/accounts');
const analyticsRoutes = require('./routes/analytics');
const teamRoutes = require('./routes/team');
const dashboardRoutes = require('./routes/dashboard');
const fansRoutes = require('./routes/fans');
const conversationsRoutes = require('./routes/conversations');
const snippetsRoutes = require('./routes/snippets');
const scriptsRoutes = require('./routes/scripts');
const revenueRoutes = require('./routes/revenue');

const { startTokenRefreshJob } = require('./services/tokenRefresh');
const { startInboxPollingJob } = require('./services/inboxPoller');

const app = express();
app.set('trust proxy', 1);

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Logging & parsing
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/fans', fansRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/snippets', snippetsRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/revenue', revenueRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Background jobs
startTokenRefreshJob();
startInboxPollingJob();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 FlowDesk server running on port ${PORT}`);
});

module.exports = app;
