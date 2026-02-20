const axios = require('axios');
const supabase = require('../config/supabase');
const { decrypt, encrypt } = require('../utils/encryption');

const FANVUE_API_BASE = 'https://api.fanvue.com/v1';
const FANVUE_TOKEN_URL = 'https://auth.fanvue.com/oauth/token';

/**
 * Get a valid access token for an account, refreshing if needed
 */
async function getValidToken(account) {
  const now = new Date();
  const expiresAt = new Date(account.token_expires_at);
  
  // Refresh if expiring within 5 minutes
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
    const refreshToken = decrypt(account.refresh_token_enc);
    
    const response = await axios.post(FANVUE_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: process.env.FANVUE_CLIENT_ID,
      client_secret: process.env.FANVUE_CLIENT_SECRET,
      refresh_token: refreshToken
    });
    
    const { access_token, refresh_token: newRefreshToken, expires_in } = response.data;
    
    // Update tokens in DB
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
    // Mark account as needing reconnection
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
async function fanvueRequest(account, method, endpoint, data = null) {
  const token = await getValidToken(account);
  
  const config = {
    method,
    url: `${FANVUE_API_BASE}${endpoint}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  
  if (data) config.data = data;
  
  const response = await axios(config);
  return response.data;
}

/**
 * Fetch creator profile
 */
async function getProfile(account) {
  return fanvueRequest(account, 'GET', '/creator/profile');
}

/**
 * Fetch subscribers list
 */
async function getSubscribers(account, page = 1, limit = 50) {
  return fanvueRequest(account, 'GET', `/creator/subscribers?page=${page}&limit=${limit}`);
}

/**
 * Fetch earnings summary
 */
async function getEarnings(account, period = '30d') {
  return fanvueRequest(account, 'GET', `/creator/earnings?period=${period}`);
}

/**
 * Fetch earnings breakdown by type
 */
async function getEarningsBreakdown(account) {
  return fanvueRequest(account, 'GET', '/creator/earnings/breakdown');
}

/**
 * Fetch recent messages
 */
async function getMessages(account, page = 1, limit = 50) {
  return fanvueRequest(account, 'GET', `/creator/messages?page=${page}&limit=${limit}`);
}

/**
 * Send a message to a fan
 */
async function sendMessage(account, fanId, content) {
  return fanvueRequest(account, 'POST', `/creator/messages/${fanId}`, { content });
}

/**
 * Fetch fan count stats
 */
async function getStats(account) {
  return fanvueRequest(account, 'GET', '/creator/stats');
}

/**
 * Fetch PPV performance
 */
async function getPPVStats(account) {
  return fanvueRequest(account, 'GET', '/creator/ppv/stats');
}

module.exports = {
  getProfile,
  getSubscribers,
  getEarnings,
  getEarningsBreakdown,
  getMessages,
  sendMessage,
  getStats,
  getPPVStats,
  getValidToken,
  refreshToken
};
