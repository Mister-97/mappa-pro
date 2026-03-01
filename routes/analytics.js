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

/** Format a Date as YYYY-MM-DD (date-only, avoids time-boundary exclusions) */
function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

/**
 * Parse period → { startDate, endDate } as YYYY-MM-DD strings.
 * Date-only format ensures Fanvue includes the full start/end day
 * regardless of the exact time the request is made.
 *
 * Supported periods: today, yesterday, 7d, 14d, 30d, month, year, all
 */
function parsePeriod(period = '30d') {
  const now = new Date();
  const today = toDateStr(now);
  const daysAgo = (n) => toDateStr(new Date(Date.now() - n * 86400000));

  switch (period) {
    case 'today':
      return { startDate: today, endDate: today };

    case 'yesterday': {
      const y = daysAgo(1);
      return { startDate: y, endDate: today };
    }

    case '7d':
      return { startDate: daysAgo(7), endDate: today };

    case '14d':
      return { startDate: daysAgo(14), endDate: today };

    case '30d':
      return { startDate: daysAgo(30), endDate: today };

    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: toDateStr(start), endDate: today };
    }

    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { startDate: toDateStr(start), endDate: today };
    }

    case 'all':
      // 2-year lookback — covers any Fanvue account history
      return { startDate: daysAgo(730), endDate: today };

    default: {
      const days = parseInt(period) || 30;
      return { startDate: daysAgo(days), endDate: today };
    }
  }
}

/**
 * Split [startDate, endDate] (YYYY-MM-DD) into ≤chunkDays windows.
 * Fanvue Insights API rejects date ranges longer than ~30 days.
 * Handles same-day ranges by returning a single chunk.
 */
function buildChunks(startDate, endDate, chunkDays = 28) {
  const chunks = [];
  let cur = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();

  // Same day or reversed — return single chunk
  if (cur >= end) {
    chunks.push({ startDate, endDate });
    return chunks;
  }

  const step = chunkDays * 86400000;
  while (cur < end) {
    const next = Math.min(cur + step, end);
    chunks.push({ startDate: toDateStr(new Date(cur)), endDate: toDateStr(new Date(next)) });
    cur = next;
  }
  return chunks;
}

// Max chunks processed in parallel per fetch call.
// 3 concurrent keeps us well under Fanvue's rate limit while ~3× faster than sequential.
const CHUNK_CONCURRENCY = 3;

/**
 * Fetch all earnings pages for a single chunk (follows nextCursor).
 * Returns raw Fanvue data array (values still in cents).
 */
async function fetchEarningsChunk(account, chunk) {
  const data = [];
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
      data.push(...(r?.data || []));
      cursor = r?.nextCursor || null;
    } catch (e) {
      console.error(`[Analytics] earnings chunk ${chunk.startDate} error:`, e.message);
      break;
    }
  } while (cursor && ++pages < 20);
  return data;
}

/**
 * Fetch earnings for a date range.
 * Splits into 28-day chunks (Fanvue API limit), processes CHUNK_CONCURRENCY
 * chunks in parallel, and follows cursor pagination within each chunk.
 * Returns raw Fanvue data array (values still in cents).
 */
async function fetchEarnings(account, startDate, endDate) {
  const chunks = buildChunks(startDate, endDate);
  const allData = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.all(batch.map(c => fetchEarningsChunk(account, c)));
    results.forEach(d => allData.push(...d));
  }
  return allData;
}

/**
 * Fetch subscriber daily history for a date range.
 * Same chunked + parallel approach as fetchEarnings.
 */
async function fetchSubscribers(account, startDate, endDate) {
  const chunks = buildChunks(startDate, endDate);
  const allData = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.all(batch.map(async (chunk) => {
      try {
        const r = await withRetry(() => fanvueApi.getInsightsSubscribers(account, {
          startDate: chunk.startDate,
          endDate: chunk.endDate
        }));
        return r?.data || [];
      } catch (e) {
        console.error(`[Analytics] subscribers chunk ${chunk.startDate} error:`, e.message);
        return [];
      }
    }));
    results.forEach(d => allData.push(...d));
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

      // Use gross to match Fanvue's dashboard display
      const earningsTotal = earningsRaw.reduce((s, tx) => s + toDollars(tx.gross || 0), 0);
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

    // Use gross to match Fanvue's display
    const total = data.reduce((s, tx) => s + (tx.gross || 0), 0);
    const breakdown = data.reduce((acc, tx) => {
      const src = tx.source || 'other';
      acc[src] = (acc[src] || 0) + (tx.gross || 0);
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
