const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/signup
 * Create a new agency owner account + organization
 */
router.post('/signup', async (req, res, next) => {
  try {
    const { name, email, password, agencyName } = req.body;
    
    if (!name || !email || !password || !agencyName) {
      return res.status(400).json({ error: 'All fields required' });
    }
    
    // Check if email already exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Create organization
    const orgId = uuidv4();
    const { error: orgError } = await supabase
      .from('organizations')
      .insert({
        id: orgId,
        name: agencyName,
        plan: 'starter',
        created_at: new Date().toISOString()
      });
    
    if (orgError) throw orgError;
    
    // Create user
    const userId = uuidv4();
    const { error: userError } = await supabase
      .from('users')
      .insert({
        id: userId,
        name,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        role: 'owner',
        organization_id: orgId,
        created_at: new Date().toISOString()
      });
    
    if (userError) throw userError;
    
    // Generate JWT
    const token = generateToken(userId);
    
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: userId, name, email, role: 'owner', organization_id: orgId }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Fetch user
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, password_hash, role, organization_id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user.id);
    
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organization_id: user.organization_id
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

function generateToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = router;
