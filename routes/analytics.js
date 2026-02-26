const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

// Disable caching for all analytics routes
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/**
 * Helper: cents → dollars
 */
const toDollars = (cents) => (cents || 0) / 100;

/**
 * Helper: parse period string into startDate/endDate ISO strings
 * Accepts: '7d', '30d', '90d', 'all'
 */
function parsePeriod(period = '30d') {
  if (period === 'all') return {};
  const days = parseInt(period) || 30;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = new Date().toISOString().split('T')[0];
  return { startDate, endDate };
}

/**
 * GET /api/analytics/overview
 * Aggregate analytics across ALL connected accounts in the org.
 * Uses Insights API (getInsightsEarnings + getInsightsSubscribers + getStats)
 */
router.get('/overview', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    // Get all active accounts
    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('organization_id', req.user.organization_id)
      .eq('is_active', true);

    if (error) throw error;
    if (!accounts || accounts.length === 0) {
      return res.json({ accounts: [], totals: { earnings: 0, subscribers: 0, newSubscribers: 0, messages: 0 } });
    }

    const accountsData = await Promise.all(
      accounts.map(async (account) => {
        const [statsResult, earningsResult, subscribersResult] = await Promise.allSettled([
          fanvueApi.getStats(account),
          fanvueApi.getInsightsEarnings(account, { startDate, endDate, limit: 100 }),
          fanvueApi.getInsightsSubscribers(account, { startDate, endDate })
        ]);

        const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;

        // Log any errors to help debug
        if (statsResult.status === 'rejected') console.error('[Analytics] getStats error:', statsResult.reason?.message);
        if (earningsResult.status === 'rejected') console.error('[Analytics] getInsightsEarnings error:', earningsResult.reason?.message);
        if (subscribersResult.status === 'rejected') console.error('[Analytics] getInsightsSubscribers error:', subscribersResult.reason?.message);

        // Sum earnings from insights data array
        let earningsTotal = 0;
        if (earningsResult.status === 'fulfilled') {
          const earningsData = earningsResult.value?.data || [];
          earningsTotal = earningsData.reduce((sum, tx) => sum + toDollars(tx.net || tx.gross || 0), 0);
        }

        // Latest subscriber count from history, or fall back to stats
        let subscriberCount = stats?.subscriberCount || 0;
        let newSubscribers = 0;
        if (subscribersResult.status === 'fulfilled') {
          const subHistory = subscribersResult.value?.data || [];
          if (subHistory.length > 0) {
            subscriberCount = subHistory[subHistory.length - 1]?.count ?? subscriberCount;
            newSubscribers = subHistory.length > 1
              ? (subHistory[subHistory.length - 1]?.count || 0) - (subHistory[0]?.count || 0)
              : 0;
          }
        }

        return {
          accountId: account.id,
          label: account.label,
          fanvue_username: account.fanvue_username,
          avatar_url: account.avatar_url,
          earnings: earningsTotal,
          subscriberCount,
          newSubscribers,
          followerCount: stats?.followerCount || 0,
          error: statsResult.status === 'rejected' ? statsResult.reason?.message : null
        };
      })
    );

    const totals = accountsData.reduce((acc, a) => {
      acc.earnings += a.earnings || 0;
      acc.subscribers += a.subscriberCount || 0;
      acc.newSubscribers += a.newSubscribers || 0;
      return acc;
    }, { earnings: 0, subscribers: 0, newSubscribers: 0 });

    res.json({ accounts: accountsData, totals, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/earnings
 * Cursor-paginated earnings for a single account using Insights API.
 * Query params: period (7d/30d/90d/all), cursor, source
 */
router.get('/:accountId/earnings', authenticate, async (req, res, next) => {
  try {
    const { period = '30d', cursor, source } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const result = await fanvueApi.getInsightsEarnings(account, {
      cursor,
      source,
      startDate,
      endDate,
      limit: 50
    });

    // Normalise cents → dollars
    const data = (result?.data || []).map(tx => ({
      ...tx,
      gross: toDollars(tx.gross),
      net: toDollars(tx.net),
      fee: toDollars(tx.fee)
    }));

    const total = data.reduce((sum, tx) => sum + (tx.net || 0), 0);

    // Breakdown by source
    const breakdown = data.reduce((acc, tx) => {
      const src = tx.source || 'other';
      acc[src] = (acc[src] || 0) + (tx.net || 0);
      return acc;
    }, {});

    res.json({ data, total, breakdown, nextCursor: result?.nextCursor || null, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/top-spenders
 * Top-spending fans for a single account.
 * Query params: page, size
 */
router.get('/:accountId/top-spenders', authenticate, async (req, res, next) => {
  try {
    const { page = 1, size = 20 } = req.query;

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const result = await fanvueApi.getTopSpenders(account, { page: parseInt(page), size: parseInt(size) });

    // Normalise cents → dollars
    const data = (result?.data || []).map(fan => ({
      ...fan,
      gross: toDollars(fan.gross),
      net: toDollars(fan.net)
    }));

    res.json({ data, pagination: result?.pagination || {}, page });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/subscribers
 * Daily subscriber count history for a single account.
 * Query params: period (7d/30d/90d/all)
 */
router.get('/:accountId/subscribers', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const result = await fanvueApi.getInsightsSubscribers(account, { startDate, endDate });
    const data = result?.data || [];

    // Derive net change
    const startCount = data[0]?.count || 0;
    const endCount = data[data.length - 1]?.count || 0;
    const netChange = endCount - startCount;

    res.json({ data, currentCount: endCount, netChange, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/spending
 * Reversal/refund/chargeback data for a single account.
 * Query params: period, cursor
 */
router.get('/:accountId/spending', authenticate, async (req, res, next) => {
  try {
    const { period = '30d', cursor } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const result = await fanvueApi.getInsightsSpending(account, { cursor, startDate, endDate, limit: 50 });

    const data = (result?.data || []).map(item => ({
      ...item,
      amount: toDollars(item.amount)
    }));

    res.json({ data, nextCursor: result?.nextCursor || null, period });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
