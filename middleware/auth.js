const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

/**
 * Auth bypass mode — set AUTH_BYPASS=true in env to skip JWT entirely.
 * A default dev user is injected so all req.user references still work.
 */
const DEV_USER = {
  id: process.env.DEFAULT_USER_ID || 'dev-user',
  email: 'dev@flowdesk.local',
  name: 'Dev User',
  role: 'owner',
  organization_id: process.env.DEFAULT_ORG_ID || 'dev-org'
};

async function authenticate(req, res, next) {
  // Bypass mode — no login needed
  if (process.env.AUTH_BYPASS === 'true') {
    req.user = DEV_USER;
    return next();
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role, organization_id, name')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
