const cron = require('node-cron');
const supabase = require('../config/supabase');
const fanvueApi = require('./fanvueApi');
const { v4: uuidv4 } = require('uuid');

/**
 * Poll Fanvue inbox every 60 seconds for all active accounts.
 * Syncs new conversations into conversations + fans tables.
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
    // Mark sync as running
    await supabase
      .from('inbox_sync_state')
      .upsert({
        account_id: account.id,
        sync_status: 'syncing',
        updated_at: new Date().toISOString()
      });

    // Fetch latest chats from Fanvue
    // Response: { data: [{ user, lastMessage, isRead, unreadMessagesCount, ... }], pagination }
    const response = await fanvueApi.getChats(account, 1, 50);
    if (!response?.data?.length) {
      await supabase
        .from('inbox_sync_state')
        .upsert({
          account_id: account.id,
          last_synced_at: new Date().toISOString(),
          sync_status: 'idle',
          error_message: null,
          updated_at: new Date().toISOString()
        });
      return;
    }

    let newMessageCount = 0;

    for (const chat of response.data) {
      // Fanvue chat object shape:
      // chat.user = { uuid, username, displayName, avatarUrl, ... }
      // chat.lastMessage = { uuid, text, sentAt, sender: { uuid }, ... }
      // chat.isRead, chat.unreadMessagesCount
      const fan_user = chat.user;
      const lastMsg = chat.lastMessage;

      if (!fan_user?.uuid) continue;

      // Upsert fan record
      const { data: fan } = await supabase
        .from('fans')
        .upsert({
          account_id: account.id,
          organization_id: account.organization_id,
          fanvue_fan_id: fan_user.uuid,
          username: fan_user.username,
          display_name: fan_user.displayName,
          avatar_url: fan_user.avatarUrl,
          last_active_at: lastMsg?.sentAt || null,
          last_message_at: lastMsg?.sentAt || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'account_id,fanvue_fan_id' })
        .select('id')
        .single();

      if (!fan) continue;

      // Check if conversation needs updating
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id, last_message_at, unread_count')
        .eq('account_id', account.id)
        .eq('fan_id', fan.id)
        .single();

      const isNew = !existingConv ||
        new Date(lastMsg?.sentAt) > new Date(existingConv.last_message_at || 0);

      if (isNew) {
        newMessageCount++;

        // Determine message direction: inbound if sender is the fan
        const isFromFan = lastMsg?.sender?.uuid === fan_user.uuid;
        const lastMessageFrom = isFromFan ? 'fan' : 'creator';

        await supabase
          .from('conversations')
          .upsert({
            account_id: account.id,
            organization_id: account.organization_id,
            fan_id: fan.id,
            fanvue_thread_id: fan_user.uuid, // Fanvue uses fan UUID as thread ID
            is_unread: !chat.isRead,
            unread_count: chat.unreadMessagesCount || 0,
            last_message_at: lastMsg?.sentAt || null,
            last_message_preview: lastMsg?.text?.substring(0, 100) || null,
            last_message_from: lastMessageFrom,
            status: 'open',
            updated_at: new Date().toISOString()
          }, { onConflict: 'account_id,fan_id' });

        // Fetch recent messages and sync to DB to keep cache warm
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('account_id', account.id)
          .eq('fan_id', fan.id)
          .single();

        if (conv) {
          try {
            const msgResponse = await fanvueApi.getChatMessages(account, fan_user.uuid, 1, 50, false);
            const fanvueMsgs = msgResponse?.data || [];
            if (fanvueMsgs.length > 0) {
              const toUpsert = fanvueMsgs.map(msg => {
                const msgIsFromFan = msg.sender?.uuid === fan_user.uuid;
                return {
                  id: msg.uuid,
                  conversation_id: conv.id,
                  organization_id: account.organization_id,
                  fanvue_message_id: msg.uuid,
                  direction: msgIsFromFan ? 'inbound' : 'outbound',
                  content: msg.text || null,
                  media_urls: msg.attachments?.map(a => a.url || a.fileUrl).filter(Boolean) || [],
                  is_ppv: (msg.pricing?.price > 0) || false,
                  ppv_price: msg.pricing?.price || null,
                  ppv_unlocked: msg.pricing?.isUnlocked || false,
                  sent_at: msg.sentAt || msg.createdAt,
                  platform_status: 'delivered'
                };
              });
              await supabase
                .from('messages')
                .upsert(toUpsert, { onConflict: 'fanvue_message_id' });
            }
          } catch (msgErr) {
            console.error(`[InboxPoller] Message sync error for ${fan_user.username}:`, msgErr.message);
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

    // If it's an auth error, try refreshing the token before giving up
    if (err.message?.includes('401') || err.message?.includes('403')) {
      try {
        await fanvueApi.refreshToken(account);
        console.log(`[InboxPoller] Token refreshed for ${account.fanvue_username}, will retry next cycle`);
      } catch (refreshErr) {
        // refreshToken already marks needs_reconnect on definitive auth failures
        console.error(`[InboxPoller] Token refresh also failed for ${account.fanvue_username}:`, refreshErr.message);
      }
    }
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
