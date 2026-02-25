const axios = require('axios');
const supabase = require('../config/supabase');
const { decrypt, encrypt } = require('../utils/encryption');

const FANVUE_API_BASE = 'https://api.fanvue.com';
const FANVUE_TOKEN_URL = 'https://auth.fanvue.com/oauth/token';
const FANVUE_API_VERSION = '2025-06-26';

/**
 * Get a valid access token for an account, refreshing if needed
 */
async function getValidToken(account) {
  const now = new Date();
  const expiresAt = new Date(account.token_expires_at);

  if (expiresAt - now < 5 * 60 * 1000) {
    return await refreshToken(account);
  }

  return decrypt(account.access_token_enc);
}

/**
 * Refresh an expired token
 */
async function refreshToken(account) {
  try {
    const currentRefreshToken = decrypt(account.refresh_token_enc);

    const response = await axios.post(FANVUE_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: process.env.FANVUE_CLIENT_ID,
      client_secret: process.env.FANVUE_CLIENT_SECRET,
      refresh_token: currentRefreshToken
    });

    const { access_token, refresh_token: newRefreshToken, expires_in } = response.data;

    await supabase
      .from('connected_accounts')
      .update({
        access_token_enc: encrypt(access_token),
        refresh_token_enc: encrypt(newRefreshToken),
        token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', account.id);

    return access_token;
  } catch (err) {
    await supabase
      .from('connected_accounts')
      .update({ is_active: false, needs_reconnect: true })
      .eq('id', account.id);

    throw new Error(`Token refresh failed for account ${account.id}: ${err.message}`);
  }
}

/**
 * Make an authenticated API call to Fanvue
 */
async function fanvueRequest(account, method, endpoint, data = null, params = null) {
  const token = await getValidToken(account);

  const config = {
    method,
    url: `${FANVUE_API_BASE}${endpoint}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Fanvue-API-Version': FANVUE_API_VERSION,
      'Content-Type': 'application/json'
    }
  };

  if (data) config.data = data;
  if (params) config.params = params;

  const response = await axios(config);
  return response.data;
}

/**
 * Get the current authenticated user profile
 * GET /users/me
 */
async function getProfile(account) {
  return fanvueRequest(account, 'GET', '/users/me');
}

/**
 * Get creator stats — uses /users/me which includes subscriber/follower/content counts
 * NOTE: subscriber/follower counts are nested under profile.fanCounts per API spec
 */
async function getStats(account) {
  const profile = await fanvueRequest(account, 'GET', '/users/me');
  return {
    subscriberCount: profile?.fanCounts?.subscribersCount || 0,
    followerCount: profile?.fanCounts?.followersCount || 0,
    imageCount: profile?.imageCount || 0,
    videoCount: profile?.videoCount || 0,
    postCount: profile?.postCount || 0,
    newSubscribers: 0
  };
}

/**
 * Get earnings for a period
 * GET /creator/earnings?period=
 */
async function getEarnings(account, period = '30d') {
  try {
    return await fanvueRequest(account, 'GET', '/creator/earnings', null, { period });
  } catch {
    try {
      return await fanvueRequest(account, 'GET', '/earnings', null, { period });
    } catch {
      return { total: 0, currency: 'USD', period };
    }
  }
}

/**
 * Get earnings breakdown (PPV, subscription, tips)
 * GET /creator/earnings/breakdown
 */
async function getEarningsBreakdown(account) {
  try {
    return await fanvueRequest(account, 'GET', '/creator/earnings/breakdown');
  } catch {
    return { ppv: 0, subscription: 0, tips: 0, other: 0 };
  }
}

/**
 * Get subscriber list
 * GET /subscriptions?page=
 */
async function getSubscribers(account, page = 1) {
  try {
    return await fanvueRequest(account, 'GET', '/subscriptions', null, { page, size: 50 });
  } catch {
    return { data: [], pagination: { total: 0 } };
  }
}

/**
 * Get PPV performance stats
 * GET /creator/ppv/stats
 */
async function getPPVStats(account) {
  try {
    return await fanvueRequest(account, 'GET', '/creator/ppv/stats');
  } catch {
    return { totalSales: 0, totalRevenue: 0, conversionRate: 0 };
  }
}

/**
 * Get list of chat conversations (paginated)
 * GET /chats
 */
async function getChats(account, page = 1, size = 50, filter = null, sortBy = 'most_recent_messages') {
  const params = { page, size, sortBy };
  if (filter) params.filter = filter;
  return fanvueRequest(account, 'GET', '/chats', null, params);
}

/**
 * Get messages from a specific chat
 * GET /chats/{userUuid}/messages
 */
async function getChatMessages(account, userUuid, page = 1, size = 50, markAsRead = false) {
  const params = { page, size, markAsRead: markAsRead ? 'true' : 'false' };
  return fanvueRequest(account, 'GET', `/chats/${userUuid}/messages`, null, params);
}

/**
 * Send a message to a user
 * POST /chats/{userUuid}/message
 */
async function sendMessage(account, userUuid, { text = null, mediaUuids = [], price = null, templateUuid = null } = {}) {
  const body = {};
  if (text !== null) body.text = text;
  if (mediaUuids.length > 0) body.mediaUuids = mediaUuids;
  if (price !== null) body.price = price;
  if (templateUuid !== null) body.templateUuid = templateUuid;
  return fanvueRequest(account, 'POST', `/chats/${userUuid}/message`, body);
}

/**
 * Send a mass message
 * POST /chats/mass-messages
 */
async function sendMassMessage(account, { text, mediaUuids = [], price = null, includedLists, excludedLists = null }) {
  const body = { text, includedLists };
  if (mediaUuids.length > 0) body.mediaUuids = mediaUuids;
  if (price !== null) body.price = price;
  if (excludedLists) body.excludedLists = excludedLists;
  return fanvueRequest(account, 'POST', '/chats/mass-messages', body);
}

/**
 * Get unread chats count
 * GET /chats/unread
 */
async function getUnreadCount(account) {
  return fanvueRequest(account, 'GET', '/chats/unread');
}

/**
 * Update chat properties
 * PATCH /chats/{userUuid}
 */
async function updateChat(account, userUuid, { isRead, isMuted, nickname } = {}) {
  const body = {};
  if (isRead !== undefined) body.isRead = isRead;
  if (isMuted !== undefined) body.isMuted = isMuted;
  if (nickname !== undefined) body.nickname = nickname;
  return fanvueRequest(account, 'PATCH', `/chats/${userUuid}`, body);
}

/**
 * Get online statuses for multiple users
 * POST /chats/statuses
 */
async function getBatchStatuses(account, userUuids) {
  return fanvueRequest(account, 'POST', '/chats/statuses', { userUuids });
}

/**
 * Delete a message
 * DELETE /chats/{userUuid}/messages/{messageUuid}
 */
async function deleteMessage(account, userUuid, messageUuid) {
  return fanvueRequest(account, 'DELETE', `/chats/${userUuid}/messages/${messageUuid}`);
}

/**
 * Get media from a chat
 * GET /chats/{userUuid}/media
 */
async function getChatMedia(account, userUuid, { cursor = null, mediaType = null, limit = 20 } = {}) {
  const params = { limit };
  if (cursor) params.cursor = cursor;
  if (mediaType) params.mediaType = mediaType;
  return fanvueRequest(account, 'GET', `/chats/${userUuid}/media`, null, params);
}

module.exports = {
  getProfile,
  getStats,
  getEarnings,
  getEarningsBreakdown,
  getSubscribers,
  getPPVStats,
  getChats,
  getChatMessages,
  sendMessage,
  sendMassMessage,
  getUnreadCount,
  updateChat,
  getBatchStatuses,
  deleteMessage,
  getChatMedia,
  getValidToken,
  refreshToken
};
