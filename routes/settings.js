'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/settings
 * Returns current user profile + org info in one call.
 */
router.get('/', async (req, res, next) => {
  try {
    const { data: user, error: ue } = await supabase
      .from('users')
      .select('id, name, email, role')
      .eq('id', req.user.id)
      .single();
    if (ue) throw ue;

    const { data: org, error: oe } = await supabase
      .from('organizations')
      .select('id, name, plan, created_at')
      .eq('id', req.user.organization_id)
      .single();
    if (oe) throw oe;

    res.json({ user, org });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/profile
 * Update current user's display name.
 * Body: { name }
 */
router.patch('/profile', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (name.trim().length > 80) {
      return res.status(400).json({ error: 'Name must be 80 characters or fewer' });
    }

    const { error } = await supabase
      .from('users')
      .update({ name: name.trim() })
      .eq('id', req.user.id);
    if (error) throw error;

    res.json({ ok: true, name: name.trim() });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/password
 * Change password — requires current password.
 * Body: { currentPassword, newPassword }
 */
router.patch('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Fetch password hash — not in req.user for security
    const { data: user, error: ue } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', req.user.id)
      .single();
    if (ue || !user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    const { error } = await supabase
      .from('users')
      .update({ password_hash: hash })
      .eq('id', req.user.id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/organization
 * Update organization name — owner only.
 * Body: { name }
 */
router.patch('/organization', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can update organization settings' });
    }

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Organization name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Organization name must be 100 characters or fewer' });
    }

    const { error } = await supabase
      .from('organizations')
      .update({ name: name.trim() })
      .eq('id', req.user.organization_id);
    if (error) throw error;

    res.json({ ok: true, name: name.trim() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
