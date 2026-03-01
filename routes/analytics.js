const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');
const { withRetry } = require('../utils/rateLimitRetry');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const toDollars = (cents) => (cents || 0) / 100;

/**
 * Parse period → { startDate, endDate } as ISO strings.
 * 'all' = last 12 months (covers full mumu account history).
 */
function parsePeriod(period = '30d') {
  const endDate = new Date().toISOString();
  if (period === 'all') {
    return { startDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), endDate };
  }
  const days = parseInt(period) || 30;
  return { startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(), endDate };
}

/**
 * Split [start, end] into chunks of at most chunkDays days.
 * Fanvue Insights API rejects date ranges longer than ~30 days.
 */
function buildChunks(startDate, endDate, chunkDays = 28) {
  const chunks = [];
  let cur = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const step = chunkDays * 24 * 60 * 60 * 1000;
  while (cur < end) {
    const next = Math.min(cur + step, end);
    chunks.push({ startDate: new Date(cur).toISOString(), endDate: new Date(next).toISOString() });
    cur = next;
  }
  return chunks;
}

/**
 * Fetch earnings transactions for a date range.
 * - ≤31 days  → single direct call (original behaviour, known-good for 7d/30d)
 * - >31 days  → sequential 28-day chunks to stay under Fanvue's range limit
 *               without hammering their rate limit with parallel requests.
 * Returns raw Fanvue data array (values still in cents).
 */
async function fetchEarnings(account, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / 86400000;

  if (totalDays <= 31) {
    try {
      const r = await withRetry(() => fanvueApi.getInsightsEarnings(account, { startDate, endDate, limit: 100 }));
      return r?.data || [];
    } catch (e) {
      console.error('[Analytics] fetchEarnings error:', e.message);
      return [];
    }
  }

  // Sequential chunks — avoids Fanvue rate-limit issues from parallel bursts
  const allData = [];
  for (const chunk of buildChunks(startDate, endDate)) {
    let cursor = null;
    let pages = 0;
    do {
      try {
        const r = await withRetry(() => fanvueApi.getInsightsEarnings(account, {
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          cursor: cursor || undefined,
          limit: 100
        }));
        allData.push(...(r?.data || []));
        cursor = r?.nextCursor || null;
      } catch (e) {
        console.error(`[Analytics] chunk ${chunk.startDate} error:`, e.message);
        break;
      }
    } while (cursor && ++pages < 10);
  }
  return allData;
}

/**
 * Fetch subscriber daily history for a date range (same single/chunked logic).
 */
async function fetchSubscribers(account, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / 86400000;

  if (totalDays <= 31) {
    try {
      const r = await withRetry(() => fanvueApi.getInsightsSubscribers(account, { startDate, endDate }));
      return r?.data || [];
    } catch (e) {
      console.error('[Analytics] fetchSubscribers error:', e.message);
      return [];
    }
  }

  const allData = [];
  for (const chunk of buildChunks(startDate, endDate)) {
    try {
      const r = await withRetry(() => fanvueApi.getInsightsSubscribers(account, {
        startDate: chunk.startDate,
        endDate: chunk.endDate
      }));
      allData.push(...(r?.data || []));
    } catch (e) {
      console.error(`[Analytics] sub chunk ${chunk.startDate} error:`, e.message);
    }
  }
  return allData;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/overview
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
    if (!accounts?.length) {
      return res.json({ accounts: [], totals: { earnings: 0, subscribers: 0, newSubscribers: 0 } });
    }

    const accountsData = await Promise.all(accounts.map(async (account) => {
      const [statsResult] = await Promise.allSettled([fanvueApi.getStats(account)]);
      if (statsResult.status === 'rejected')
        console.error('[Analytics] getStats error:', statsResult.reason?.message);

      const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
      const earningsRaw = await fetchEarnings(account, startDate, endDate);
      const subData = await fetchSubscribers(account, startDate, endDate);

      const earningsTotal = earningsRaw.reduce((s, tx) => s + toDollars(tx.net || tx.gross || 0), 0);
      const newSubscribers = subData.reduce((s, d) => s + (d.newSubscribersCount || 0), 0);

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
    }));

    const totals = accountsData.reduce(
      (acc, a) => ({ earnings: acc.earnings + (a.earnings || 0), subscribers: acc.subscribers + (a.subscriberCount || 0), newSubscribers: acc.newSubscribers + (a.newSubscribers || 0) }),
      { earnings: 0, subscribers: 0, newSubscribers: 0 }
    );

    res.json({ accounts: accountsData, totals, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/earnings
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

    const raw = await fetchEarnings(account, startDate, endDate);

    const data = raw
      .filter(tx => !source || source === 'all' || tx.source === source)
      .map(tx => ({ ...tx, gross: toDollars(tx.gross), net: toDollars(tx.net), fee: toDollars(tx.fee) }));

    const total = data.reduce((s, tx) => s + (tx.net || 0), 0);
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

    const data = await fetchSubscribers(account, startDate, endDate);
    const newSubscribers = data.reduce((s, d) => s + (d.newSubscribersCount || 0), 0);
    const cancelledSubscribers = data.reduce((s, d) => s + (d.cancelledSubscribersCount || 0), 0);
    const netChange = data.length > 0 ? (data[data.length - 1]?.total || 0) : 0;

    res.json({ data, newSubscribers, cancelledSubscribers, netChange, period });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/:accountId/spending
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
    const data = (result?.data || []).map(item => ({ ...item, amount: toDollars(item.amount) }));

    res.json({ data, nextCursor: result?.nextCursor || null, period });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
