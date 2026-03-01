const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const fanvueApi = require('../services/fanvueApi');

const router = express.Router();

// ============================================================
// CHAT TEMPLATES
// ============================================================

/**
 * GET /api/templates?accountId=X&page=1&size=50&folderName=Y
 * List templates for a connected account
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { accountId, page = 1, size = 50, folderName } = req.query;

    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    const response = await fanvueApi.getTemplates(account, {
      page: Number(page),
      size: Number(size),
      folderName: folderName || null
    });

    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/templates/:templateUuid?accountId=X
 * Get a single template by UUID
 */
router.get('/:templateUuid', authenticate, async (req, res, next) => {
  try {
    const { accountId } = req.query;

    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const { data: account, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('organization_id', req.user.organization_id)
      .single();
    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    const response = await fanvueApi.getTemplate(account, req.params.templateUuid);

    res.json(response);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
