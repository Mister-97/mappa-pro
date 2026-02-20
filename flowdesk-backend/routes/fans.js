const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

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
        fan_notes(id, content, created_at, author:users(name))
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
 * Add internal note
 */
router.post('/:fanId/notes', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
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
        content
      })
      .select('id, content, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({ note });
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
