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
 * Helper: parse period into { startDate, endDate } — always returns real ISO dates.
 * Fanvue Insights API has a ~30-day max date range per request, so callers that need
 * longer ranges must use fetchEarningsChunked / fetchSubscribersChunked below.
 */
function parsePeriod(period = '30d') {
  const endDate = new Date().toISOString();
  if (period === 'all') {
    // 18 months back covers typical account history; chunks handle the range limit
    const startDate = new Date(Date.now() - 18 * 30 * 24 * 60 * 60 * 1000).toISOString();
    return { startDate, endDate };
  }
  const days = parseInt(period) || 30;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return { startDate, endDate };
}

/**
 * Split [startDate, endDate] into chunks of at most chunkDays days.
 * Fanvue's Insights API rejects date ranges longer than ~30 days.
 */
function buildChunks(startDate, endDate, chunkDays = 28) {
  const chunks = [];
  let cursor = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const step = chunkDays * 24 * 60 * 60 * 1000;
  while (cursor < end) {
    const chunkEnd = Math.min(cursor + step, end);
    chunks.push({
      startDate: new Date(cursor).toISOString(),
      endDate: new Date(chunkEnd).toISOString()
    });
    cursor = chunkEnd;
  }
  return chunks;
}

/**
 * Fetch ALL earnings transactions for [startDate, endDate], transparently chunking
 * into 28-day windows and handling cursor pagination within each window.
 * Returns raw Fanvue data (cents, not converted).
 */
async function fetchEarningsChunked(account, startDate, endDate) {
  const chunks = buildChunks(startDate, endDate);

  // Fetch all chunks in parallel to keep latency low
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const data = [];
      let nextCursor = null;
      let page = 0;
      do {
        try {
          const result = await fanvueApi.getInsightsEarnings(account, {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            cursor: nextCursor || undefined,
            limit: 100
          });
          data.push(...(result?.data || []));
          nextCursor = result?.nextCursor || null;
        } catch (e) {
          console.error(`[Analytics] earnings chunk ${chunk.startDate} error:`, e.message);
          break;
        }
        page++;
        if (page > 20) break; // safety
      } while (nextCursor);
      return data;
    })
  );

  return chunkResults.flat();
}

/**
 * Fetch subscriber daily history for [startDate, endDate], chunked into 28-day windows.
 * Returns combined daily data array.
 */
async function fetchSubscribersChunked(account, startDate, endDate) {
  const chunks = buildChunks(startDate, endDate);

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const result = await fanvueApi.getInsightsSubscribers(account, {
          startDate: chunk.startDate,
          endDate: chunk.endDate
        });
        return result?.data || [];
      } catch (e) {
        console.error(`[Analytics] subscribers chunk ${chunk.startDate} error:`, e.message);
        return [];
      }
    })
  );

  return chunkResults.flat();
}

/**
 * GET /api/analytics/overview
 * Aggregate analytics across ALL connected accounts in the org.
 */
router.get('/overview', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('organization_id', req.user.organization_id)
      .eq('is_active', true);

    if (error) throw error;
    if (!accounts || accounts.length === 0) {
      return res.json({ accounts: [], totals: { earnings: 0, subscribers: 0, newSubscribers: 0 } });
    }

    const accountsData = await Promise.all(
      accounts.map(async (account) => {
        const [statsResult, earningsRaw, subHistory] = await Promise.allSettled([
          fanvueApi.getStats(account),
          fetchEarningsChunked(account, startDate, endDate),
          fetchSubscribersChunked(account, startDate, endDate)
        ]);

        if (statsResult.status === 'rejected')
          console.error('[Analytics] getStats error:', statsResult.reason?.message);

        const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;

        const earningsData = earningsRaw.status === 'fulfilled' ? earningsRaw.value : [];
        const earningsTotal = earningsData.reduce((sum, tx) => sum + toDollars(tx.net || tx.gross || 0), 0);

        const subData = subHistory.status === 'fulfilled' ? subHistory.value : [];
        const newSubscribers = subData.reduce((sum, d) => sum + (d.newSubscribersCount || 0), 0);

        return {
          accountId: account.id,
          label: account.label,
          fanvue_username: account.fanvue_username,
          avatar_url: account.avatar_url,
          earnings: earningsTotal,
          subscriberCount: stats?.subscriberCount || 0,
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
 * All earnings for a single account, chunked across the full period.
 * Query params: period (7d/30d/90d/all), source
 */
router.get('/:accountId/earnings', authenticate, async (req, res, next) => {
  try {
    const { period = '30d', source } = req.query;
    const { startDate, endDate } = parsePeriod(period);

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    // Use chunked fetcher so 90d and all-time work correctly
    const raw = await fetchEarningsChunked(account, startDate, endDate);

    // Normalise cents → dollars, optionally filter by source
    const data = raw
      .filter(tx => !source || source === 'all' || tx.source === source)
      .map(tx => ({
        ...tx,
        gross: toDollars(tx.gross),
        net: toDollars(tx.net),
        fee: toDollars(tx.fee)
      }));

    const total = data.reduce((sum, tx) => sum + (tx.net || 0), 0);

    const breakdown = data.reduce((acc, tx) => {
      const src = tx.source || 'other';
      acc[src] = (acc[src] || 0) + (tx.net || 0);
      return acc;
    }, {});

    res.json({ data, total, breakdown, period });
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

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    const result = await fanvueApi.getTopSpenders(account, { page: parseInt(page), size: parseInt(size) });

    const data = (result?.data || []).map(fan => ({
      ...fan,
      gross: toDollars(fan.gross),
      net: toDollars(fan.net),
      fanId: fan.user?.id || fan.fanId,
      username: fan.user?.username || fan.username,
      display_name: fan.user?.display_name || fan.display_name,
      avatar_url: fan.user?.avatar_url || fan.avatar_url
    }));

    res.json({ data, pagination: result?.pagination || {}, page });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/subscribers
 * Daily subscriber count history, chunked across the full period.
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

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    const data = await fetchSubscribersChunked(account, startDate, endDate);

    const newSubscribers = data.reduce((sum, d) => sum + (d.newSubscribersCount || 0), 0);
    const cancelledSubscribers = data.reduce((sum, d) => sum + (d.cancelledSubscribersCount || 0), 0);
    const netChange = data.length > 0 ? (data[data.length - 1]?.total || 0) : 0;

    res.json({ data, newSubscribers, cancelledSubscribers, netChange, period });
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

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

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
