const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

/**
 * GET /api/fans?accountId=&tier=&tag=&sort=&search=
 * List fans for an account with filtering + sorting
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { accountId, tier, tag, sort = 'last_active', search, page = 1, limit = 50 } = req.query;

    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    // Verify account belongs to org
    const { data: account } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('id', accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!account) return res.status(404).json({ error: 'Account not found' });

    let query = supabase
      .from('fans')
      .select(`
        id, fanvue_fan_id, username, display_name, avatar_url,
        subscription_status, lifetime_spend, spend_30d, spend_7d,
        ppv_unlock_count, ppv_sent_count, buyer_score, spend_tier,
        last_active_at, last_message_at, last_purchase_at,
        needs_follow_up, message_count,
        fan_tags(tag)
      `, { count: 'exact' })
      .eq('account_id', accountId);

    // Filters
    if (tier) query = query.eq('spend_tier', tier);
    if (search) query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);

    // Sorting
    const sortMap = {
      last_active: { col: 'last_active_at', asc: false },
      buyer_score: { col: 'buyer_score', asc: false },
      lifetime_spend: { col: 'lifetime_spend', asc: false },
      spend_30d: { col: 'spend_30d', asc: false },
      last_message: { col: 'last_message_at', asc: false }
    };
    const s = sortMap[sort] || sortMap.last_active;
    query = query.order(s.col, { ascending: s.asc });

    // Pagination
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data: fans, error, count } = await query;
    if (error) throw error;

    // If tag filter — post-filter (Supabase join filter limitation)
    const filtered = tag
      ? fans.filter(f => f.fan_tags?.some(t => t.tag === tag))
      : fans;

    res.json({ fans: filtered, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/fans/:fanId/insights
 * Fetch real-time spending + subscription data from Fanvue Insights API
 * Returns normalized data ready for the fan detail panel
 */
router.get('/:fanId/insights', authenticate, async (req, res, next) => {
  try {
    // Load fan with account credentials
    const { data: fan, error: fanError } = await supabase
      .from('fans')
      .select('id, fanvue_fan_id, account_id')
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (fanError || !fan) return res.status(404).json({ error: 'Fan not found' });
    if (!fan.fanvue_fan_id) return res.status(422).json({ error: 'Fan has no Fanvue UUID' });

    // Load account with credentials
    const { data: account, error: accountError } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', fan.account_id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (accountError || !account) return res.status(404).json({ error: 'Account not found' });

    // Call Fanvue Insights API
    const raw = await fanvueApi.getFanInsights(account, fan.fanvue_fan_id);

    // Normalize: amounts are in cents, convert to dollars
    const spending = raw.spending || {};
    const subscription = raw.subscription || {};
    const sources = spending.sources || {};

    const insights = {
      // Fan status
      fan_type: raw.status || null, // subscriber | expired | follower | not_contactable

      // Spending totals (cents → dollars)
      lifetime_spend: spending.total?.gross != null ? spending.total.gross / 100 : null,
      last_purchase_at: spending.lastPurchaseAt || null,
      max_single_payment: spending.maxSinglePayment?.gross != null ? spending.maxSinglePayment.gross / 100 : null,

      // Spending by source (cents → dollars)
      ppv_total: sources.message?.gross != null ? sources.message.gross / 100 : null,
      tip_total: sources.tip?.gross != null ? sources.tip.gross / 100 : null,
      subscription_total: sources.subscription?.gross != null ? sources.subscription.gross / 100 : null,
      renewal_total: sources.renewal?.gross != null ? sources.renewal.gross / 100 : null,
      post_total: sources.post?.gross != null ? sources.post.gross / 100 : null,

      // Subscription info
      subscription_status: raw.status || null,
      subscription_started_at: subscription.createdAt || null,
      subscription_renews_at: subscription.renewsAt || null,
      auto_renew: subscription.autoRenewalEnabled ?? null,

      // Raw for debugging
      _raw: raw
    };

    res.json({ insights });
  } catch (err) {
    // If the Fanvue API returns a 404 the fan may not exist on their side
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Fan not found on Fanvue' });
    }
    next(err);
  }
});

/**
 * GET /api/fans/:fanId
 * Full fan profile with notes, tags, recent revenue
 */
router.get('/:fanId', authenticate, async (req, res, next) => {
  try {
    const { data: fan, error } = await supabase
      .from('fans')
      .select(`
        *,
        fan_tags(id, tag, created_at),
        fan_notes(id, content, category, created_at, author:users(name))
      `)
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !fan) return res.status(404).json({ error: 'Fan not found' });

    // Recent revenue events
    const { data: revenueEvents } = await supabase
      .from('revenue_events')
      .select('event_type, amount, occurred_at')
      .eq('fan_id', req.params.fanId)
      .order('occurred_at', { ascending: false })
      .limit(20);

    // Active script run
    const { data: activeScript } = await supabase
      .from('script_runs')
      .select('id, script_id, current_step, started_at, scripts(name)')
      .eq('fan_id', req.params.fanId)
      .eq('status', 'active')
      .single();

    res.json({ fan, revenueEvents: revenueEvents || [], activeScript });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/fans/:fanId/tags
 * Add tag to fan
 */
router.post('/:fanId/tags', authenticate, async (req, res, next) => {
  try {
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ error: 'tag required' });

    // Verify fan belongs to org
    const { data: fan } = await supabase
      .from('fans')
      .select('id')
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!fan) return res.status(404).json({ error: 'Fan not found' });

    const { error } = await supabase
      .from('fan_tags')
      .insert({
        id: uuidv4(),
        fan_id: req.params.fanId,
        organization_id: req.user.organization_id,
        tag: tag.toLowerCase().trim(),
        tagged_by: req.user.id
      });

    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'Tag already exists' });
    }
    if (error) throw error;

    res.status(201).json({ message: 'Tag added' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/fans/:fanId/tags/:tag
 */
router.delete('/:fanId/tags/:tag', authenticate, async (req, res, next) => {
  try {
    await supabase
      .from('fan_tags')
      .delete()
      .eq('fan_id', req.params.fanId)
      .eq('tag', req.params.tag)
      .eq('organization_id', req.user.organization_id);

    res.json({ message: 'Tag removed' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/fans/:fanId/notes
 * Add internal note (supports optional category: 'all' | 'must_know' | 'top_facts')
 */
router.post('/:fanId/notes', authenticate, async (req, res, next) => {
  try {
    const { content, category = 'all' } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    const { data: fan } = await supabase
      .from('fans')
      .select('id')
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!fan) return res.status(404).json({ error: 'Fan not found' });

    const { data: note, error } = await supabase
      .from('fan_notes')
      .insert({
        id: uuidv4(),
        fan_id: req.params.fanId,
        organization_id: req.user.organization_id,
        author_id: req.user.id,
        content,
        category
      })
      .select('id, content, category, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({ note });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/fans/:fanId/general-notes
 * Save general notes textarea for a fan
 */
router.patch('/:fanId/general-notes', authenticate, async (req, res, next) => {
  try {
    const { notes } = req.body;
    if (notes === undefined) return res.status(400).json({ error: 'notes required' });

    const { error } = await supabase
      .from('fans')
      .update({ notes, updated_at: new Date().toISOString() })
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;
    res.json({ message: 'Notes saved' });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/fans/:fanId
 * Update fan fields (timezone, needs_follow_up, notes quick field)
 */
router.patch('/:fanId', authenticate, async (req, res, next) => {
  try {
    const allowed = ['timezone', 'needs_follow_up', 'follow_up_at', 'notes'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('fans')
      .update(updates)
      .eq('id', req.params.fanId)
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;
    res.json({ message: 'Fan updated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
