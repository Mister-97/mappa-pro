const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');

const router = express.Router();

const FANVUE_AUTH_URL = 'https://auth.fanvue.com/oauth2/auth';
const FANVUE_TOKEN_URL = 'https://auth.fanvue.com/oauth2/token';
const FANVUE_API_BASE = 'https://api.fanvue.com/v1';

// In-memory PKCE store (use Redis in production)
const pkceStore = new Map();

/**
 * GET /api/oauth/connect
 * Initiate Fanvue OAuth flow for a creator account
 * Query param: ?label=ModelName (optional display name)
 */
router.get('/connect', authenticate, (req, res) => {
  const { label } = req.query;
  
  // Generate PKCE
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  
  // State carries userId + label for callback
  const state = crypto.randomBytes(16).toString('hex');
  
  pkceStore.set(state, {
    codeVerifier,
    userId: req.user.id,
    organizationId: req.user.organization_id,
    label: label || 'Unnamed Model',
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 min
  });
  
  const params = new URLSearchParams({
    client_id: process.env.FANVUE_CLIENT_ID,
    redirect_uri: process.env.FANVUE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid offline_access offline read:self read:chat read:creator',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  
  res.json({ authUrl: `${FANVUE_AUTH_URL}?${params.toString()}` });
});

/**
 * GET /api/oauth/callback
 * Fanvue redirects here after creator authorizes
 */
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    
    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?oauth_error=${error}`);
    }
    
    // Validate state & get PKCE data
    const pkceData = pkceStore.get(state);
    if (!pkceData || Date.now() > pkceData.expiresAt) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?oauth_error=invalid_state`);
    }
    pkceStore.delete(state);
    
    // Exchange code for tokens
    const tokenResponse = await axios.post(FANVUE_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: process.env.FANVUE_CLIENT_ID,
      client_secret: process.env.FANVUE_CLIENT_SECRET,
      redirect_uri: process.env.FANVUE_REDIRECT_URI,
      code,
      code_verifier: pkceData.codeVerifier
    });
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Fetch creator profile from Fanvue
    const profileResponse = await axios.get(`${FANVUE_API_BASE}/creator/profile`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    
    const profile = profileResponse.data;
    
    // Check if this Fanvue account is already connected
    const { data: existing } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('fanvue_user_id', profile.id)
      .eq('organization_id', pkceData.organizationId)
      .single();
    
    const accountData = {
      organization_id: pkceData.organizationId,
      connected_by: pkceData.userId,
      label: pkceData.label,
      fanvue_user_id: profile.id,
      fanvue_username: profile.username,
      fanvue_display_name: profile.displayName || profile.username,
      avatar_url: profile.avatarUrl || null,
      // Encrypt tokens before storing — NEVER store plain text
      access_token_enc: encrypt(access_token),
      refresh_token_enc: encrypt(refresh_token),
      token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      is_active: true,
      last_synced: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    if (existing) {
      // Update existing connection
      await supabase
        .from('connected_accounts')
        .update(accountData)
        .eq('id', existing.id);
    } else {
      // New connection
      await supabase
        .from('connected_accounts')
        .insert({ id: uuidv4(), created_at: new Date().toISOString(), ...accountData });
    }
    
    // Trigger initial data sync
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?oauth_success=true&account=${profile.username}`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?oauth_error=token_exchange_failed`);
  }
});

/**
 * DELETE /api/oauth/disconnect/:accountId
 * Remove a connected Fanvue account
 */
router.delete('/disconnect/:accountId', authenticate, async (req, res, next) => {
  try {
    const { accountId } = req.params;
    
    // Verify this account belongs to the user's org
    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('id, organization_id')
      .eq('id', accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    
    if (error || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    await supabase
      .from('connected_accounts')
      .update({ is_active: false, access_token_enc: null, refresh_token_enc: null })
      .eq('id', accountId);
    
    res.json({ message: 'Account disconnected successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
