const cron = require('node-cron');
const supabase = require('../config/supabase');
const fanvueApi = require('./fanvueApi');
const { v4: uuidv4 } = require('uuid');

/**
 * Poll Fanvue inbox every 60 seconds for all active accounts.
 * Syncs new/updated chats into conversations + fans tables.
 *
 * Real Fanvue chat object shape:
 * {
 *   user: { uuid, username, displayName, profileImageUrl },
 *   lastMessage: { uuid, text, sentAt, sender },  // sender: 'creator' | 'fan'
 *   isRead: bool,
 *   unreadMessagesCount: number,
 *   lastMessageAt: ISO string,
 *   isMuted: bool,
 *   createdAt: ISO string
 * }
 *
 * IMPORTANT: In Fanvue's API, the fan's UUID *is* the chat identifier.
 * There is no separate threadId — we store fan.uuid as fanvue_thread_id.
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
    // Fetch the 30 most recently active chats
    const response = await fanvueApi.getChats(account, 1, 30, null, 'most_recent_messages');

    if (!response?.data?.length) return;

    let newMessageCount = 0;

    for (const chat of response.data) {
      const fan = chat.user;
      const lastMsg = chat.lastMessage;

      // Upsert fan — fanvue_fan_id = fan's Fanvue UUID
      const { data: fanRow } = await supabase
        .from('fans')
        .upsert({
          account_id: account.id,
          organization_id: account.organization_id,
          fanvue_fan_id: fan.uuid,
          username: fan.username,
          display_name: fan.displayName,
          avatar_url: fan.profileImageUrl,
          last_message_at: chat.lastMessageAt,
          last_active_at: chat.lastMessageAt,
          updated_at: new Date().toISOString()
        }, { onConflict: 'account_id,fanvue_fan_id' })
        .select('id')
        .single();

      if (!fanRow) continue;

      // Check if this chat has newer activity than what we have
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id, last_message_at, unread_count')
        .eq('account_id', account.id)
        .eq('fan_id', fanRow.id)
        .single();

      const isNewer = !existingConv ||
        new Date(chat.lastMessageAt) > new Date(existingConv.last_message_at || 0);

      if (isNewer) {
        newMessageCount++;

        // Upsert conversation
        await supabase
          .from('conversations')
          .upsert({
            account_id: account.id,
            organization_id: account.organization_id,
            fan_id: fanRow.id,
            fanvue_thread_id: fan.uuid,   // fan UUID is the chat identifier
            is_unread: !chat.isRead,
            unread_count: chat.unreadMessagesCount || 0,
            last_message_at: chat.lastMessageAt,
            last_message_preview: lastMsg?.text?.substring(0, 100) || (lastMsg?.uuid ? '[Media]' : null),
            last_message_from: lastMsg?.sender === 'creator' ? 'model' : 'fan',
            status: 'open',
            updated_at: new Date().toISOString()
          }, { onConflict: 'account_id,fan_id' });

        // Cache the last inbound message if it came from the fan
        if (lastMsg?.sender === 'fan' && lastMsg?.uuid) {
          const { data: existingMsg } = await supabase
            .from('messages')
            .select('id')
            .eq('fanvue_message_id', lastMsg.uuid)
            .single();

          if (!existingMsg) {
            // Need the conversation id — re-query after upsert
            const { data: conv } = await supabase
              .from('conversations')
              .select('id')
              .eq('account_id', account.id)
              .eq('fan_id', fanRow.id)
              .single();

            if (conv) {
              await supabase.from('messages').insert({
                id: uuidv4(),
                conversation_id: conv.id,
                organization_id: account.organization_id,
                fanvue_message_id: lastMsg.uuid,
                direction: 'inbound',
                content: lastMsg.text || null,
                sent_at: lastMsg.sentAt
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
