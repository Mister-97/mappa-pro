const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

// ============================================================
// CONVERSATIONS (inbox)
// ============================================================

/**
 * GET /api/conversations?accountId=&sort=&filter=&page=
 * Inbox for a model — filtered, sorted, paginated
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const {
      accountId, sort = 'last_message', filter,
      search, page = 1, limit = 40
    } = req.query;

    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    // Role gate: chatters only see assigned accounts
    if (req.user.role === 'chatter') {
      const { data: assignment } = await supabase
        .from('chatter_assignments')
        .select('id')
        .eq('chatter_id', req.user.id)
        .eq('account_id', accountId)
        .single();
      if (!assignment) return res.status(403).json({ error: 'Not assigned to this account' });
    }

    let query = supabase
      .from('conversations')
      .select(`
        id, fanvue_thread_id, is_unread, unread_count,
        last_message_at, last_message_preview, last_message_from,
        needs_follow_up, is_pinned, status,
        assigned_chatter_id,
        locked_by, locked_at,
        fan:fans(
          id, username, display_name, avatar_url,
          subscription_status, spend_tier, buyer_score,
          lifetime_spend, spend_30d, last_active_at,
          fan_tags(tag)
        )
      `, { count: 'exact' })
      .eq('account_id', accountId)
      .eq('organization_id', req.user.organization_id)
      .eq('status', 'open');

    // Filters
    if (filter === 'unread') query = query.eq('is_unread', true);
    if (filter === 'follow_up') query = query.eq('needs_follow_up', true);
    if (filter === 'mine') query = query.eq('assigned_chatter_id', req.user.id);

    // Pinned always float to top, then newest message first
    query = query.order('is_pinned', { ascending: false });
    query = query.order('last_message_at', { ascending: false, nullsFirst: false });

    // Pagination
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data: conversations, error, count } = await query;
    if (error) throw error;

    // Post-filter search
    const results = search
      ? conversations.filter(c =>
          c.fan?.username?.toLowerCase().includes(search.toLowerCase()) ||
          c.fan?.display_name?.toLowerCase().includes(search.toLowerCase())
        )
      : conversations;

    res.json({ conversations: results, total: count, page: Number(page) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/conversations/:conversationId
 * Single conversation with messages — always chronological (oldest first)
 */
router.get('/:conversationId', authenticate, async (req, res, next) => {
  try {
    const { data: conversation, error } = await supabase
      .from('conversations')
      .select(`
        *,
        fan:fans(*, fan_tags(tag), fan_notes(id, content, created_at, author:users(name))),
        assigned_chatter:users(id, name)
      `)
      .eq('id', req.params.conversationId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !conversation) return res.status(404).json({ error: 'Conversation not found' });

    // Mark as read
    await supabase
      .from('conversations')
      .update({ is_unread: false, unread_count: 0 })
      .eq('id', req.params.conversationId);

    // Messages — oldest at top, newest at bottom (chronological chat order)
    // Sort by sent_at ASC, fall back to created_at ASC for messages without a sent_at
    const { data: messages } = await supabase
      .from('messages')
      .select(`
        id, direction, content, media_urls, is_ppv, ppv_price,
        ppv_unlocked, ppv_unlocked_at, sent_at, platform_status,
        sent_by_user:users(id, name), sent_by_automation, script_run_id
      `)
      .eq('conversation_id', req.params.conversationId)
      .order('sent_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(200);

    // Get active script run if any
    const { data: activeRun } = await supabase
      .from('script_runs')
      .select('id, current_step, script:scripts(id, name, script_steps(*))')
      .eq('conversation_id', req.params.conversationId)
      .eq('status', 'active')
      .single();

    res.json({ conversation, messages: messages || [], activeRun });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/conversations/:conversationId/lock
 */
router.post('/:conversationId/lock', authenticate, async (req, res, next) => {
  try {
    const { data: conv } = await supabase
      .from('conversations')
      .select('locked_by, locked_at')
      .eq('id', req.params.conversationId)
      .single();

    if (!conv) return res.status(404).json({ error: 'Not found' });

    const lockAge = conv.locked_at
      ? (Date.now() - new Date(conv.locked_at).getTime()) / 1000
      : 999;

    if (conv.locked_by && conv.locked_by !== req.user.id && lockAge < 60) {
      const { data: locker } = await supabase
        .from('users')
        .select('name')
        .eq('id', conv.locked_by)
        .single();
      return res.status(409).json({
        error: 'locked',
        lockedBy: locker?.name || 'Another chatter',
        lockedAt: conv.locked_at
      });
    }

    await supabase
      .from('conversations')
      .update({ locked_by: req.user.id, locked_at: new Date().toISOString() })
      .eq('id', req.params.conversationId);

    res.json({ locked: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/conversations/:conversationId/lock
 */
router.delete('/:conversationId/lock', authenticate, async (req, res, next) => {
  try {
    await supabase
      .from('conversations')
      .update({ locked_by: null, locked_at: null })
      .eq('id', req.params.conversationId)
      .eq('locked_by', req.user.id);

    res.json({ released: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/conversations/:conversationId
 */
router.patch('/:conversationId', authenticate, async (req, res, next) => {
  try {
    const allowed = ['assigned_chatter_id', 'needs_follow_up', 'follow_up_at', 'is_pinned', 'status'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', req.params.conversationId)
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;
    res.json({ message: 'Updated' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// MESSAGES
// ============================================================

/**
 * POST /api/conversations/:conversationId/messages
 */
router.post('/:conversationId/messages', authenticate, async (req, res, next) => {
  try {
    const { content, mediaUrls = [], isPpv = false, ppvPrice, scriptRunId } = req.body;

    if (!content && mediaUrls.length === 0) {
      return res.status(400).json({ error: 'content or media required' });
    }

    const { data: conv, error: convError } = await supabase
      .from('conversations')
      .select('*, account:connected_accounts(*), fan:fans(fanvue_fan_id)')
      .eq('id', req.params.conversationId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (convError || !conv) return res.status(404).json({ error: 'Conversation not found' });

    const fanUserUuid = conv.fan?.fanvue_fan_id;

    let fanvueMessageId = null;
    try {
      const fanvueResponse = await fanvueApi.sendMessage(
        conv.account,
        fanUserUuid,
        {
          text: content || null,
          mediaUuids: [],
          price: isPpv && ppvPrice ? ppvPrice : null
        }
      );
      fanvueMessageId = fanvueResponse?.uuid || null;
    } catch (apiErr) {
      console.error('Fanvue send error:', apiErr.message);
    }

    const msgId = uuidv4();
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        id: msgId,
        conversation_id: req.params.conversationId,
        organization_id: req.user.organization_id,
        fanvue_message_id: fanvueMessageId,
        direction: 'outbound',
        content,
        media_urls: mediaUrls,
        is_ppv: isPpv,
        ppv_price: ppvPrice || null,
        sent_by_user_id: req.user.id,
        script_run_id: scriptRunId || null,
        platform_status: fanvueMessageId ? 'sent' : 'pending',
        sent_at: new Date().toISOString()
      })
      .select()
      .single();

    if (msgError) throw msgError;

    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: content?.substring(0, 100) || '[Media]',
        last_message_from: 'model',
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.conversationId);

    await supabase.rpc('increment_fan_message_count', { fan_id: conv.fan_id });

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/conversations/sync/:accountId
 */
router.post('/sync/:accountId', authenticate, async (req, res, next) => {
  try {
    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', req.params.accountId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    syncInbox(account).catch(err => console.error('Sync error:', err.message));

    res.json({ message: 'Sync initiated', accountId: req.params.accountId });
  } catch (err) {
    next(err);
  }
});

/**
 * Sync inbox from Fanvue API into our DB
 */
async function syncInbox(account) {
  try {
    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        sync_status: 'syncing',
        updated_at: new Date().toISOString()
      });

    // Fetch chats sorted by most recent message
    const response = await fanvueApi.getChats(account, 1, 50, null, 'most_recent_messages');

    if (!response?.data?.length) {
      await supabase
        .from('inbox_sync_state')
        .upsert({
          account_id: account.id,
          sync_status: 'idle',
          last_synced_at: new Date().toISOString(),
          error_message: null,
          updated_at: new Date().toISOString()
        });
      return;
    }

    for (const chat of response.data) {
      const fan = chat.user;
      const lastMsg = chat.lastMessage;

      // Use the most reliable timestamp available
      const lastMessageAt = chat.lastMessageAt ||
        lastMsg?.createdAt ||
        lastMsg?.sentAt ||
        new Date().toISOString();

      const { data: fanRow } = await supabase
        .from('fans')
        .upsert({
          account_id: account.id,
          organization_id: account.organization_id,
          fanvue_fan_id: fan.uuid,
          username: fan.username,
          display_name: fan.displayName,
          avatar_url: fan.profileImageUrl,
          last_message_at: lastMessageAt,
          last_active_at: lastMessageAt,
          updated_at: new Date().toISOString()
        }, { onConflict: 'account_id,fanvue_fan_id' })
        .select('id')
        .single();

      if (!fanRow) continue;

      await supabase
        .from('conversations')
        .upsert({
          account_id: account.id,
          organization_id: account.organization_id,
          fan_id: fanRow.id,
          fanvue_thread_id: fan.uuid,
          is_unread: !chat.isRead,
          unread_count: chat.unreadMessagesCount || 0,
          last_message_at: lastMessageAt,
          last_message_preview: lastMsg?.text?.substring(0, 100) || (lastMsg?.uuid ? '[Media]' : null),
          last_message_from: lastMsg?.sender === 'creator' ? 'model' : 'fan',
          status: 'open',
          updated_at: new Date().toISOString()
        }, { onConflict: 'account_id,fan_id' });
    }

    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        sync_status: 'idle',
        last_synced_at: new Date().toISOString(),
        error_message: null,
        updated_at: new Date().toISOString()
      });

  } catch (err) {
    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        sync_status: 'error',
        error_message: err.message,
        updated_at: new Date().toISOString()
      });
    throw err;
  }
}

module.exports = router;
