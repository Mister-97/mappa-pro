const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/revenue/event
 * Record a revenue event (called when Fanvue notifies us of purchase)
 */
router.post('/event', authenticate, async (req, res, next) => {
  try {
    const {
      accountId, fanId, chatterId, messageId,
      scriptRunId, eventType, amount, fanvueEventId, occurredAt
    } = req.body;

    if (!accountId || !eventType || !amount) {
      return res.status(400).json({ error: 'accountId, eventType, amount required' });
    }

    const { data: event, error } = await supabase
      .from('revenue_events')
      .insert({
        id: uuidv4(),
        organization_id: req.user.organization_id,
        account_id: accountId,
        fan_id: fanId || null,
        chatter_id: chatterId || null,
        message_id: messageId || null,
        script_run_id: scriptRunId || null,
        event_type: eventType,
        amount,
        fanvue_event_id: fanvueEventId || null,
        occurred_at: occurredAt || new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Event already recorded' });
      throw error;
    }

    // Update fan spend stats
    if (fanId) {
      await supabase.rpc('update_fan_spend', {
        p_fan_id: fanId,
        p_amount: amount,
        p_event_type: eventType
      });

      // Update script run revenue if applicable
      if (scriptRunId) {
        const { data: run } = await supabase
          .from('script_runs')
          .select('revenue_generated')
          .eq('id', scriptRunId)
          .single();

        if (run) {
          await supabase
            .from('script_runs')
            .update({ revenue_generated: (run.revenue_generated || 0) + amount, converted: true })
            .eq('id', scriptRunId);
        }
      }
    }

    res.status(201).json({ event });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/revenue/summary?period=30d&accountId=
 * Revenue summary with attribution breakdown
 */
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const { period = '30d', accountId } = req.query;

    const periodMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days = periodMap[period] || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    let query = supabase
      .from('revenue_events')
      .select('event_type, amount, chatter_id, script_run_id, occurred_at, fan_id')
      .eq('organization_id', req.user.organization_id)
      .gte('occurred_at', since);

    // Role gate
    if (req.user.role === 'chatter') {
      query = query.eq('chatter_id', req.user.id);
    } else if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const { data: events, error } = await query;
    if (error) throw error;

    // Aggregate
    const totals = { subscription: 0, ppv: 0, tip: 0, renewal: 0, total: 0 };
    const byChatter = {};
    const byScript = {};
    let scriptAttributed = 0;
    let automationAttributed = 0;
    let manualAttributed = 0;

    events.forEach(ev => {
      totals[ev.event_type] = (totals[ev.event_type] || 0) + Number(ev.amount);
      totals.total += Number(ev.amount);

      if (ev.chatter_id) {
        byChatter[ev.chatter_id] = (byChatter[ev.chatter_id] || 0) + Number(ev.amount);
        manualAttributed += Number(ev.amount);
      }

      if (ev.script_run_id) {
        byScript[ev.script_run_id] = (byScript[ev.script_run_id] || 0) + Number(ev.amount);
        scriptAttributed += Number(ev.amount);
      }
    });

    res.json({
      period,
      totals,
      attribution: {
        script: scriptAttributed,
        manual: manualAttributed,
        automation: automationAttributed,
        unattributed: totals.total - scriptAttributed - manualAttributed - automationAttributed
      },
      eventCount: events.length
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/revenue/leaderboard
 * Chatter revenue leaderboard
 */
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: events } = await supabase
      .from('revenue_events')
      .select('chatter_id, amount, event_type')
      .eq('organization_id', req.user.organization_id)
      .gte('occurred_at', since)
      .not('chatter_id', 'is', null);

    if (!events) return res.json({ leaderboard: [] });

    // Group by chatter
    const chatterMap = {};
    events.forEach(ev => {
      if (!chatterMap[ev.chatter_id]) {
        chatterMap[ev.chatter_id] = { chatterId: ev.chatter_id, total: 0, ppv: 0, tips: 0, subs: 0 };
      }
      chatterMap[ev.chatter_id].total += Number(ev.amount);
      if (ev.event_type === 'ppv') chatterMap[ev.chatter_id].ppv += Number(ev.amount);
      if (ev.event_type === 'tip') chatterMap[ev.chatter_id].tips += Number(ev.amount);
      if (ev.event_type === 'subscription') chatterMap[ev.chatter_id].subs += Number(ev.amount);
    });

    // Fetch chatter names
    const chatterIds = Object.keys(chatterMap);
    const { data: chatters } = await supabase
      .from('users')
      .select('id, name')
      .in('id', chatterIds);

    const leaderboard = Object.values(chatterMap)
      .map(c => ({
        ...c,
        name: chatters?.find(u => u.id === c.chatterId)?.name || 'Unknown'
      }))
      .sort((a, b) => b.total - a.total);

    res.json({ leaderboard, period });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
