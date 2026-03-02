const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { encrypt } = require('../utils/encryption');

const router = express.Router();

const FANVUE_AUTH_URL = 'https://auth.fanvue.com/oauth2/auth';
const FANVUE_TOKEN_URL = 'https://auth.fanvue.com/oauth2/token';
const FANVUE_API_BASE = 'https://api.fanvue.com';

/**
 * GET /api/oauth/connect
 * Initiate Fanvue OAuth flow for a creator account.
 * Resolves user/org from JWT token query param, falls back to AUTH_BYPASS env vars.
 * Query params: ?label=ModelName&token=JWT&accountId=UUID (for reconnects)
 */
router.get('/connect', async (req, res) => {
  const { label, token, accountId } = req.query;

  // Resolve user identity from JWT token or AUTH_BYPASS defaults
  let userId = process.env.DEFAULT_USER_ID || 'dev-user';
  let organizationId = process.env.DEFAULT_ORG_ID || 'dev-org';

  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { data: user } = await supabase
        .from('users')
        .select('id, organization_id')
        .eq('id', decoded.userId)
        .single();
      if (user) {
        userId = user.id;
        organizationId = user.organization_id;
      }
    } catch (e) {
      // fall through to defaults
    }
  }

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Encode PKCE data in the state as a signed JWT — survives server restarts
  const state = jwt.sign({
    codeVerifier,
    userId,
    organizationId,
    label: (label || '').trim() || 'New Account',
    accountId: accountId || null
  }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const params = new URLSearchParams({
    client_id: process.env.FANVUE_CLIENT_ID,
    redirect_uri: process.env.FANVUE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid offline_access offline read:self read:chat read:creator write:chat read:fan read:insights read:media',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  // Redirect directly to Fanvue — no JSON, no copy-pasting
  res.redirect(`${FANVUE_AUTH_URL}?${params.toString()}`);
});

/**
 * GET /api/oauth/callback
 * Fanvue redirects here after creator authorizes
 */
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}?oauth_error=${error}`);
    }

    let pkceData;
    try {
      pkceData = jwt.verify(state, process.env.JWT_SECRET);
    } catch (e) {
      return res.redirect(`${process.env.FRONTEND_URL}?oauth_error=invalid_state`);
    }

    // Exchange code for tokens
    const credentials = Buffer.from(
      `${process.env.FANVUE_CLIENT_ID}:${process.env.FANVUE_CLIENT_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.post(
      FANVUE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: process.env.FANVUE_REDIRECT_URI,
        code,
        code_verifier: pkceData.codeVerifier
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        }
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Fetch creator profile
    const profileResponse = await axios.get(`${FANVUE_API_BASE}/users/me`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'X-Fanvue-API-Version': '2025-06-26'
      }
    });

    const profile = profileResponse.data;

    // Check if already connected
    const { data: existing } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('fanvue_user_id', profile.uuid)
      .eq('organization_id', pkceData.organizationId)
      .single();

    const accountData = {
      organization_id: pkceData.organizationId,
      connected_by: pkceData.userId,
      label: pkceData.label,
      fanvue_user_id: profile.uuid,
      fanvue_username: profile.handle,
      fanvue_display_name: profile.displayName || profile.handle,
      avatar_url: profile.avatarUrl || null,
      access_token_enc: encrypt(access_token),
      refresh_token_enc: encrypt(refresh_token),
      token_expires_at: new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
      is_active: true,
      needs_reconnect: false, // clear flag on successful (re)connect
      last_synced: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (existing) {
      await supabase
        .from('connected_accounts')
        .update(accountData)
        .eq('id', existing.id);
    } else {
      await supabase
        .from('connected_accounts')
        .insert({ id: uuidv4(), created_at: new Date().toISOString(), ...accountData });
    }

    res.redirect(`${process.env.FRONTEND_URL}?oauth_success=true&account=${profile.handle}`);
  } catch (err) {
    console.error('OAuth callback error:', err.message, err.response?.status, JSON.stringify(err.response?.data));
    res.redirect(`${process.env.FRONTEND_URL}?oauth_error=token_exchange_failed`);
  }
});

/**
 * DELETE /api/oauth/disconnect/:accountId
 */
const { authenticate } = require('../middleware/auth');

router.delete('/disconnect/:accountId', authenticate, async (req, res, next) => {
  try {
    const { accountId } = req.params;

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
      .update({ is_active: false, needs_reconnect: true, access_token_enc: null, refresh_token_enc: null })
      .eq('id', accountId);

    res.json({ message: 'Account disconnected successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
