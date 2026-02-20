const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

/**
 * GET /api/accounts
 * List all connected Fanvue accounts for this organization
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select(`
        id,
        label,
        fanvue_username,
        fanvue_display_name,
        avatar_url,
        is_active,
        needs_reconnect,
        last_synced,
        created_at
      `)
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/accounts/:accountId
 * Get single account details + live stats from Fanvue
 */
router.get('/:accountId', authenticate, async (req, res, next) => {
  try {
    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    if (!account.is_active) {
      return res.status(400).json({ error: 'Account disconnected. Please reconnect.' });
    }
    
    // Fetch live stats from Fanvue
    const [stats, earnings] = await Promise.allSettled([
      fanvueApi.getStats(account),
      fanvueApi.getEarnings(account, '30d')
    ]);
    
    res.json({
      account: {
        id: account.id,
        label: account.label,
        fanvue_username: account.fanvue_username,
        fanvue_display_name: account.fanvue_display_name,
        avatar_url: account.avatar_url,
        is_active: account.is_active,
        needs_reconnect: account.needs_reconnect,
        last_synced: account.last_synced
      },
      stats: stats.status === 'fulfilled' ? stats.value : null,
      earnings: earnings.status === 'fulfilled' ? earnings.value : null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/accounts/:accountId
 * Update account label
 */
router.patch('/:accountId', authenticate, async (req, res, next) => {
  try {
    const { label } = req.body;
    
    const { error } = await supabase
      .from('connected_accounts')
      .update({ label, updated_at: new Date().toISOString() })
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id);
    
    if (error) throw error;
    
    res.json({ message: 'Account updated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
