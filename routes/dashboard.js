const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

/**
 * GET /api/dashboard
 * Everything the dashboard needs in one call:
 * - Connected accounts summary
 * - Aggregate totals
 * - Team overview
 * - Accounts needing reconnect
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    
    // Parallel DB queries
    const [accountsResult, teamResult, orgResult, unreadResult] = await Promise.all([
      supabase
        .from('connected_accounts')
        .select('id, label, fanvue_username, fanvue_display_name, avatar_url, is_active, needs_reconnect, last_synced')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false }),

      supabase
        .from('users')
        .select('id, name, email, role')
        .eq('organization_id', orgId),

      supabase
        .from('organizations')
        .select('id, name, plan')
        .eq('id', orgId)
        .single(),

      supabase
        .from('conversations')
        .select('account_id')
        .eq('organization_id', orgId)
        .eq('is_unread', true)
    ]);

    const accounts = accountsResult.data || [];
    const team = teamResult.data || [];
    const org = orgResult.data;

    // Build unread count map per account
    const unreadMap = new Map();
    for (const row of (unreadResult.data || [])) {
      unreadMap.set(row.account_id, (unreadMap.get(row.account_id) || 0) + 1);
    }
    accounts.forEach(a => { a.unread_count = unreadMap.get(a.id) || 0; });
    
    // Fetch live stats for active accounts (cap at 10 for speed)
    const activeAccounts = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .limit(10);
    
    let accountStats = [];
    if (activeAccounts.data?.length > 0) {
      const statsResults = await Promise.allSettled(
        activeAccounts.data.map(async (account) => {
          const [stats, earnings] = await Promise.allSettled([
            fanvueApi.getStats(account),
            fanvueApi.getEarnings(account, '30d')
          ]);
          return {
            accountId: account.id,
            stats: stats.status === 'fulfilled' ? stats.value : null,
            earnings: earnings.status === 'fulfilled' ? earnings.value : null
          };
        })
      );
      
      accountStats = statsResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
    }
    
    // Build totals
    const totals = accountStats.reduce((acc, a) => {
      acc.totalEarnings += a.earnings?.total || 0;
      acc.totalSubscribers += a.stats?.subscriberCount || 0;
      acc.newSubscribersToday += a.stats?.newSubscribersToday || 0;
      return acc;
    }, { totalEarnings: 0, totalSubscribers: 0, newSubscribersToday: 0 });
    
    res.json({
      org,
      accounts: {
        all: accounts,
        total: accounts.length,
        active: accounts.filter(a => a.is_active).length,
        needsReconnect: accounts.filter(a => a.needs_reconnect).map(a => a.fanvue_username)
      },
      stats: accountStats,
      totals,
      team: {
        members: team,
        total: team.length,
        owners: team.filter(u => u.role === 'owner').length,
        managers: team.filter(u => u.role === 'manager').length,
        chatters: team.filter(u => u.role === 'chatter').length
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
