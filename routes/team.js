const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/team
 * List all team members in the organization
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { data: members, error } = await supabase
      .from('users')
      .select(`
        id,
        name,
        email,
        role,
        created_at,
        assignments:chatter_assignments(
          id,
          account:connected_accounts(id, label, fanvue_username, avatar_url)
        )
      `)
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/team/invite
 * Invite a chatter to the organization
 * Only owners and managers can invite
 */
router.post('/invite', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { name, email, role = 'chatter' } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email required' });
    }
    
    const validRoles = ['manager', 'chatter'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be manager or chatter' });
    }
    
    // Check if email already exists in the org
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }
    
    // Create temp password — they'll reset on first login
    const tempPassword = uuidv4().slice(0, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    
    const userId = uuidv4();
    const { error } = await supabase
      .from('users')
      .insert({
        id: userId,
        name,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        role,
        organization_id: req.user.organization_id,
        must_reset_password: true,
        created_at: new Date().toISOString()
      });
    
    if (error) throw error;
    
    // TODO: Send invite email with tempPassword via SendGrid/Resend
    // For now return temp password in response (dev mode only)
    res.status(201).json({
      message: 'Team member invited',
      userId,
      ...(process.env.NODE_ENV === 'development' && { tempPassword })
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/team/assign
 * Assign a chatter to a connected Fanvue account
 */
router.post('/assign', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { chatterId, accountId } = req.body;
    
    if (!chatterId || !accountId) {
      return res.status(400).json({ error: 'chatterId and accountId required' });
    }
    
    // Verify chatter belongs to this org
    const { data: chatter } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', chatterId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (!chatter) {
      return res.status(404).json({ error: 'Chatter not found in this organization' });
    }
    
    // Verify account belongs to this org
    const { data: account } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('id', accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    // Check if assignment already exists
    const { data: existing } = await supabase
      .from('chatter_assignments')
      .select('id')
      .eq('chatter_id', chatterId)
      .eq('account_id', accountId)
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'Assignment already exists' });
    }
    
    const { error } = await supabase
      .from('chatter_assignments')
      .insert({
        id: uuidv4(),
        chatter_id: chatterId,
        account_id: accountId,
        assigned_by: req.user.id,
        created_at: new Date().toISOString()
      });
    
    if (error) throw error;
    
    res.status(201).json({ message: 'Chatter assigned to account' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/team/assign
 * Remove chatter assignment
 */
router.delete('/assign', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { chatterId, accountId } = req.body;
    
    const { error } = await supabase
      .from('chatter_assignments')
      .delete()
      .eq('chatter_id', chatterId)
      .eq('account_id', accountId);
    
    if (error) throw error;
    
    res.json({ message: 'Assignment removed' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/team/:userId
 * Remove a team member
 */
router.delete('/:userId', authenticate, requireRole('owner'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }
    
    // Remove assignments first
    await supabase
      .from('chatter_assignments')
      .delete()
      .eq('chatter_id', userId);
    
    // Remove user
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId)
      .eq('organization_id', req.user.organization_id);
    
    if (error) throw error;
    
    res.json({ message: 'Team member removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
