const cron = require('node-cron');
const supabase = require('../config/supabase');
const fanvueApi = require('./fanvueApi');
const { v4: uuidv4 } = require('uuid');

/**
 * Poll Fanvue inbox every 60 seconds for all active accounts.
 * Syncs new messages into conversations + fans tables.
 * This replaces WebSockets until we scale to that.
 */
function startInboxPollingJob() {
  cron.schedule('*/60 * * * * *', async () => {
    try {
      const { data: accounts } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('is_active', true)
        .eq('needs_reconnect', false);

      if (!accounts?.length) return;

      // Poll all accounts in parallel (cap concurrency to 5)
      const chunks = chunkArray(accounts, 5);
      for (const chunk of chunks) {
        await Promise.allSettled(chunk.map(account => pollAccount(account)));
      }
    } catch (err) {
      console.error('[InboxPoller] Error:', err.message);
    }
  });

  console.log('[InboxPoller] Started — polling every 60 seconds');
}

async function pollAccount(account) {
  try {
    // Get last sync cursor
    const { data: syncState } = await supabase
      .from('inbox_sync_state')
      .select('last_cursor, last_synced_at')
      .eq('account_id', account.id)
      .single();

    // Fetch latest messages from Fanvue
    const response = await fanvueApi.getMessages(account, 1, 30);
    if (!response?.data?.length) return;

    let newMessageCount = 0;

    for (const thread of response.data) {
      // Upsert fan record
      const { data: fan } = await supabase
        .from('fans')
        .upsert({
          account_id: account.id,
          organization_id: account.organization_id,
          fanvue_fan_id: thread.fanId,
          username: thread.fanUsername,
          display_name: thread.fanDisplayName,
          avatar_url: thread.fanAvatarUrl,
          last_active_at: thread.lastMessageAt,
          last_message_at: thread.lastMessageAt,
          updated_at: new Date().toISOString()
        }, { onConflict: 'account_id,fanvue_fan_id' })
        .select('id')
        .single();

      if (!fan) continue;

      // Check if this is newer than what we have
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id, last_message_at, unread_count')
        .eq('account_id', account.id)
        .eq('fan_id', fan.id)
        .single();

      const isNew = !existingConv ||
        new Date(thread.lastMessageAt) > new Date(existingConv.last_message_at || 0);

      if (isNew) {
        newMessageCount++;

        await supabase
          .from('conversations')
          .upsert({
            account_id: account.id,
            organization_id: account.organization_id,
            fan_id: fan.id,
            fanvue_thread_id: thread.threadId,
            is_unread: thread.unreadCount > 0,
            unread_count: thread.unreadCount || 0,
            last_message_at: thread.lastMessageAt,
            last_message_preview: thread.lastMessagePreview?.substring(0, 100),
            last_message_from: thread.lastMessageFrom,
            status: 'open',
            updated_at: new Date().toISOString()
          }, { onConflict: 'account_id,fan_id' });

        // If fan message, cache it in messages table
        if (thread.lastMessageFrom === 'fan' && thread.lastFanvueMessageId) {
          const { data: existing } = await supabase
            .from('messages')
            .select('id')
            .eq('fanvue_message_id', thread.lastFanvueMessageId)
            .single();

          if (!existing) {
            // Get conversation id
            const { data: conv } = await supabase
              .from('conversations')
              .select('id')
              .eq('account_id', account.id)
              .eq('fan_id', fan.id)
              .single();

            if (conv) {
              await supabase.from('messages').insert({
                id: uuidv4(),
                conversation_id: conv.id,
                organization_id: account.organization_id,
                fanvue_message_id: thread.lastFanvueMessageId,
                direction: 'inbound',
                content: thread.lastMessagePreview,
                sent_at: thread.lastMessageAt
              });
            }
          }
        }
      }
    }

    // Update sync state
    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        last_synced_at: new Date().toISOString(),
        sync_status: 'idle',
        error_message: null,
        updated_at: new Date().toISOString()
      });

    if (newMessageCount > 0) {
      console.log(`[InboxPoller] ${account.fanvue_username}: ${newMessageCount} updated conversations`);
    }

  } catch (err) {
    console.error(`[InboxPoller] Account ${account.fanvue_username} error:`, err.message);

    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        sync_status: 'error',
        error_message: err.message,
        updated_at: new Date().toISOString()
      });
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = { startInboxPollingJob };
