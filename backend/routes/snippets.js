const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * Resolve {{variables}} in snippet body
 */
function resolveVariables(body, context = {}) {
  return body
    .replace(/{{fan_name}}/g, context.fanName || 'babe')
    .replace(/{{model_name}}/g, context.modelName || 'me')
    .replace(/{{lifetime_spend}}/g, context.lifetimeSpend ? `$${context.lifetimeSpend}` : '')
    .replace(/{{days_subscribed}}/g, context.daysSubscribed || '')
    .replace(/{{last_tip_amount}}/g, context.lastTipAmount ? `$${context.lastTipAmount}` : '')
    .replace(/{{local_time}}/g, context.localTime || '');
}

/**
 * GET /api/snippets?accountId=&category=&search=
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { accountId, category, search } = req.query;

    let query = supabase
      .from('snippets')
      .select('id, title, body, category, is_ppv, default_ppv_price, media_urls, tag_filter, use_count, revenue_attributed, account_id')
      .eq('organization_id', req.user.organization_id)
      .eq('is_active', true)
      .order('use_count', { ascending: false });

    // Show global snippets + account-specific ones
    if (accountId) {
      query = query.or(`account_id.is.null,account_id.eq.${accountId}`);
    } else {
      query = query.is('account_id', null);
    }

    if (category) query = query.eq('category', category);
    if (search) query = query.ilike('title', `%${search}%`);

    const { data: snippets, error } = await query;
    if (error) throw error;

    res.json({ snippets });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snippets/resolve
 * Resolve variables for a snippet given fan context
 */
router.post('/resolve', authenticate, async (req, res, next) => {
  try {
    const { snippetId, fanId } = req.body;

    const { data: snippet } = await supabase
      .from('snippets')
      .select('*')
      .eq('id', snippetId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!snippet) return res.status(404).json({ error: 'Snippet not found' });

    let context = {};
    if (fanId) {
      const { data: fan } = await supabase
        .from('fans')
        .select('username, display_name, lifetime_spend, subscribed_at, last_purchase_at')
        .eq('id', fanId)
        .single();

      if (fan) {
        const daysSubscribed = fan.subscribed_at
          ? Math.floor((Date.now() - new Date(fan.subscribed_at).getTime()) / 86400000)
          : null;
        context = {
          fanName: fan.display_name || fan.username,
          lifetimeSpend: fan.lifetime_spend,
          daysSubscribed
        };
      }
    }

    // Increment use count
    await supabase
      .from('snippets')
      .update({ use_count: snippet.use_count + 1 })
      .eq('id', snippetId);

    res.json({
      resolved: resolveVariables(snippet.body, context),
      isPpv: snippet.is_ppv,
      ppvPrice: snippet.default_ppv_price,
      mediaUrls: snippet.media_urls
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snippets
 */
router.post('/', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { title, body, category = 'general', accountId, isPpv, defaultPpvPrice, mediaUrls = [], tagFilter } = req.body;

    if (!title || !body) return res.status(400).json({ error: 'title and body required' });

    const { data: snippet, error } = await supabase
      .from('snippets')
      .insert({
        id: uuidv4(),
        organization_id: req.user.organization_id,
        account_id: accountId || null,
        created_by: req.user.id,
        title, body, category,
        is_ppv: isPpv || false,
        default_ppv_price: defaultPpvPrice || null,
        media_urls: mediaUrls,
        tag_filter: tagFilter || null
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ snippet });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/snippets/:id
 */
router.patch('/:id', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const allowed = ['title', 'body', 'category', 'is_ppv', 'default_ppv_price', 'media_urls', 'tag_filter', 'is_active'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('snippets')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;
    res.json({ message: 'Updated' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/snippets/:id (soft delete)
 */
router.delete('/:id', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    await supabase
      .from('snippets')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id);

    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
