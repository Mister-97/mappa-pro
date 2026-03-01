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
 * Return midnight UTC of N calendar days ago.
 * Fanvue counts periods from the start of the calendar day, not rolling 24h windows.
 * Using midnight UTC ensures we capture transactions from the full start day.
 */
function midnightAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Parse period → { startDate, endDate } as ISO timestamp strings.
 * Fanvue API requires full ISO-8601 timestamps (date-only strings return 400).
 * Supported: today, yesterday, 7d, 14d, 30d, month, year, all
 */
function parsePeriod(period = '30d') {
  const now = new Date();
  const endDate = now.toISOString();

  switch (period) {
    case 'today': {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return { startDate: start.toISOString(), endDate };
    }
    case 'yesterday': {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 1);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setUTCHours(0, 0, 0, 0);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case '7d':
      return { startDate: midnightAgo(7), endDate };
    case '14d':
      return { startDate: midnightAgo(14), endDate };
    case '30d':
      return { startDate: midnightAgo(30), endDate };
    case 'month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { startDate: start.toISOString(), endDate };
    }
    case 'year': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { startDate: start.toISOString(), endDate };
    }
    case 'all':
      // 2-year lookback covers any Fanvue account history
      return { startDate: midnightAgo(730), endDate };
    default: {
      const days = parseInt(period) || 30;
      return { startDate: midnightAgo(days), endDate };
    }
  }
}

/**
 * Split [startDate, endDate] into ≤chunkDays windows.
 * Fanvue Insights API rejects date ranges longer than ~30 days.
 */
function buildChunks(startDate, endDate, chunkDays = 28) {
  const chunks = [];
  let cur = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const step = chunkDays * 86400000;

  if (cur >= end) {
    chunks.push({ startDate, endDate });
    return chunks;
  }

  while (cur < end) {
    const next = Math.min(cur + step, end);
    chunks.push({ startDate: new Date(cur).toISOString(), endDate: new Date(next).toISOString() });
    cur = next;
  }
  return chunks;
}

// Process up to 3 chunks in parallel — ~3× faster than sequential, safe for rate limits
const CHUNK_CONCURRENCY = 3;

/**
 * Fetch all pages for one earnings chunk, following nextCursor until exhausted.
 * Returns raw Fanvue data array (values in cents).
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
 * Fetch all earnings for a date range.
 * Always uses chunked + cursor-paginated path for all periods, including short ones.
 * Runs CHUNK_CONCURRENCY chunks in parallel for speed.
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
