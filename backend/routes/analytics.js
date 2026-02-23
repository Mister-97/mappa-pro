const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

/**
 * GET /api/analytics/overview
 * Aggregate analytics across ALL connected accounts in the org
 */
router.get('/overview', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    
    // Get all active accounts
    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('organization_id', req.user.organization_id)
      .eq('is_active', true);
    
    if (error) throw error;
    if (!accounts || accounts.length === 0) {
      return res.json({ accounts: [], totals: { earnings: 0, subscribers: 0, messages: 0 } });
    }
    
    // Fetch analytics for all accounts in parallel
    const analyticsResults = await Promise.allSettled(
      accounts.map(async (account) => {
        const [stats, earnings] = await Promise.allSettled([
          fanvueApi.getStats(account),
          fanvueApi.getEarnings(account, period)
        ]);
        
        return {
          accountId: account.id,
          label: account.label,
          fanvue_username: account.fanvue_username,
          avatar_url: account.avatar_url,
          stats: stats.status === 'fulfilled' ? stats.value : null,
          earnings: earnings.status === 'fulfilled' ? earnings.value : null,
          error: stats.status === 'rejected' ? stats.reason?.message : null
        };
      })
    );
    
    const accountsData = analyticsResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    
    // Calculate totals
    const totals = accountsData.reduce((acc, account) => {
      acc.earnings += account.earnings?.total || 0;
      acc.subscribers += account.stats?.subscriberCount || 0;
      acc.newSubscribers += account.stats?.newSubscribers || 0;
      acc.messages += account.stats?.messageCount || 0;
      return acc;
    }, { earnings: 0, subscribers: 0, newSubscribers: 0, messages: 0 });
    
    res.json({ accounts: accountsData, totals, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/earnings
 * Detailed earnings for a single account
 */
router.get('/:accountId/earnings', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    
    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const [earnings, breakdown] = await Promise.all([
      fanvueApi.getEarnings(account, period),
      fanvueApi.getEarningsBreakdown(account)
    ]);
    
    res.json({ earnings, breakdown, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/subscribers
 * Subscriber list + stats for a single account
 */
router.get('/:accountId/subscribers', authenticate, async (req, res, next) => {
  try {
    const { page = 1 } = req.query;
    
    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const subscribers = await fanvueApi.getSubscribers(account, page);
    
    res.json({ subscribers, page });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/ppv
 * PPV performance stats
 */
router.get('/:accountId/ppv', authenticate, async (req, res, next) => {
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
    
    const ppvStats = await fanvueApi.getPPVStats(account);
    
    res.json({ ppvStats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
