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
 * Single conversation with messages.
 * Fetches live messages from Fanvue API and caches them in the DB.
 */
router.get('/:conversationId', authenticate, async (req, res, next) => {
  try {
    // Use explicit FK constraint names to avoid ambiguous relationship errors
    // fan_notes.author_id -> users uses constraint: fan_notes_author_id_fkey
    const { data: conversation, error } = await supabase
      .from('conversations')
      .select(`
        *,
        fan:fans(*, fan_tags(tag), fan_notes(id, content, created_at, author:users!fan_notes_author_id_fkey(name))),
        assigned_chatter:users!assigned_chatter_id(id, name),
        account:connected_accounts(id, access_token_enc, refresh_token_enc, token_expires_at, fanvue_username)
      `)
      .eq('id', req.params.conversationId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error) {
      console.error('[ConvRoute] Supabase error fetching conversation:', error.message, error.code, error.details);
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    // Mark as read
    await supabase
      .from('conversations')
      .update({ is_unread: false, unread_count: 0 })
      .eq('id', req.params.conversationId);

    // fanvue_thread_id is the fan's Fanvue UUID — use it to fetch live messages
    const fanvueUserUuid = conversation.fanvue_thread_id || conversation.fan?.fanvue_fan_id;
    let messages = [];

    if (fanvueUserUuid && conversation.account) {
      try {
        // Fetch up to 3 pages (150 messages) from Fanvue for full history
        const pages = await Promise.allSettled([
          fanvueApi.getChatMessages(conversation.account, fanvueUserUuid, 1, 50, true),
          fanvueApi.getChatMessages(conversation.account, fanvueUserUuid, 2, 50, false),
          fanvueApi.getChatMessages(conversation.account, fanvueUserUuid, 3, 50, false),
        ]);

        const allFanvueMessages = [];
        for (const result of pages) {
          if (result.status === 'fulfilled' && result.value?.data?.length) {
            allFanvueMessages.push(...result.value.data);
          }
        }

        if (allFanvueMessages.length > 0) {
          // Map Fanvue messages to our schema
          messages = allFanvueMessages.map(msg => {
            // Fanvue message shape:
            // { uuid, text, sentAt, createdAt, sender: { uuid }, attachments, pricing }
            const isFromFan = msg.sender?.uuid === fanvueUserUuid;
            return {
              id: msg.uuid,
              fanvue_message_id: msg.uuid,
              conversation_id: conversation.id,
              direction: isFromFan ? 'inbound' : 'outbound',
              content: msg.text || null,
              media_urls: msg.attachments?.map(a => a.url || a.fileUrl).filter(Boolean) || [],
              is_ppv: (msg.pricing?.price > 0) || false,
              ppv_price: msg.pricing?.price || null,
              ppv_unlocked: msg.pricing?.isUnlocked || false,
              sent_at: msg.sentAt || msg.createdAt,
              platform_status: 'sent'
            };
          });

          // Sort chronologically (oldest first)
          messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));

          // Cache messages in DB (upsert to avoid duplicates)
          const toUpsert = messages.map(m => ({
            id: m.id,
            conversation_id: conversation.id,
            organization_id: req.user.organization_id,
            fanvue_message_id: m.fanvue_message_id,
            direction: m.direction,
            content: m.content,
            media_urls: m.media_urls,
            is_ppv: m.is_ppv,
            ppv_price: m.ppv_price,
            ppv_unlocked: m.ppv_unlocked,
            sent_at: m.sent_at,
            platform_status: m.platform_status
          }));

          // Upsert in batches of 50
          for (let i = 0; i < toUpsert.length; i += 50) {
            try {
              const { error: upsertErr } = await supabase
                .from('messages')
                .upsert(toUpsert.slice(i, i + 50), { onConflict: 'fanvue_message_id' });
              if (upsertErr) console.error('[ConvRoute] Message cache error:', upsertErr.message);
            } catch (upsertEx) {
              console.error('[ConvRoute] Message cache exception:', upsertEx.message);
            }
          }
        }
      } catch (apiErr) {
        console.error('[ConvRoute] Fanvue message fetch failed:', apiErr.message);
        // Fall back to cached messages from DB
      }
    }

    // If live fetch failed or returned nothing, fall back to DB cache
    if (!messages.length) {
      const { data: cachedMessages } = await supabase
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
      messages = cachedMessages || [];
    }

    // Get active script run if any
    const { data: activeRun } = await supabase
      .from('script_runs')
      .select('id, current_step, script:scripts(id, name, script_steps(*))')
      .eq('conversation_id', req.params.conversationId)
      .eq('status', 'active')
      .single();

    // Strip sensitive account tokens before sending response
    const { account, ...convWithoutAccount } = conversation;

    res.json({ conversation: convWithoutAccount, messages, activeRun });
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

/**
 * PATCH /api/conversations/:conversationId/nickname
 * Update the fan's nickname on Fanvue (via chat update API)
 */
router.patch('/:conversationId/nickname', authenticate, async (req, res, next) => {
  try {
    const { nickname } = req.body;
    if (typeof nickname !== 'string') return res.status(400).json({ error: 'nickname required' });

    // Load conversation with account credentials and fan UUID
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('fanvue_thread_id, account:connected_accounts(id, access_token_enc, refresh_token_enc, token_expires_at), fan:fans(id)')
      .eq('id', req.params.conversationId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !conv) return res.status(404).json({ error: 'Conversation not found' });

    const fanvueUserUuid = conv.fanvue_thread_id;
    if (!fanvueUserUuid) return res.status(400).json({ error: 'No Fanvue thread ID' });

    // Update nickname on Fanvue
    try {
      await fanvueApi.updateChat(conv.account, fanvueUserUuid, { nickname: nickname || null });
    } catch (apiErr) {
      console.error('[NicknameRoute] Fanvue updateChat failed:', apiErr.message);
      // Don't fail — just log it; we still save locally
    }

    // Also store nickname in our fans table if column exists
    if (conv.fan?.id) {
      await supabase
        .from('fans')
        .update({ nickname, updated_at: new Date().toISOString() })
        .eq('id', conv.fan.id)
        .eq('organization_id', req.user.organization_id)
        .catch(() => {}); // ignore if column doesn't exist
    }

    res.json({ message: 'Nickname updated', nickname });
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
      // API spec: 201 response returns { messageUuid: "..." }
      fanvueMessageId = fanvueResponse?.messageUuid || fanvueResponse?.uuid || null;
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
