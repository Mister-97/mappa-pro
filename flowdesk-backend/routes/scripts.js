const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// SCRIPT BUILDER (Manager/Owner)
// ============================================================

/**
 * GET /api/scripts?accountId=&status=
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { accountId, status } = req.query;

    let query = supabase
      .from('scripts')
      .select('id, name, description, script_type, scope, status, run_count, conversion_rate, revenue_attributed, avg_revenue_per_run, created_at, account_id')
      .eq('organization_id', req.user.organization_id)
      .order('run_count', { ascending: false });

    if (accountId) query = query.or(`account_id.is.null,account_id.eq.${accountId}`);
    if (status) query = query.eq('status', status);

    const { data: scripts, error } = await query;
    if (error) throw error;

    res.json({ scripts });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scripts/:scriptId
 * Full script with steps
 */
router.get('/:scriptId', authenticate, async (req, res, next) => {
  try {
    const { data: script, error } = await supabase
      .from('scripts')
      .select('*, script_steps(*)')
      .eq('id', req.params.scriptId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !script) return res.status(404).json({ error: 'Script not found' });

    script.script_steps.sort((a, b) => a.step_index - b.step_index);
    res.json({ script });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scripts
 */
router.post('/', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { name, description, scriptType = 'flow', accountId, steps = [] } = req.body;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (steps.length === 0) return res.status(400).json({ error: 'at least 1 step required' });

    const scriptId = uuidv4();

    const { error: scriptError } = await supabase
      .from('scripts')
      .insert({
        id: scriptId,
        organization_id: req.user.organization_id,
        account_id: accountId || null,
        created_by: req.user.id,
        name, description,
        script_type: scriptType,
        scope: accountId ? 'model' : 'global',
        status: 'draft'
      });

    if (scriptError) throw scriptError;

    // Insert steps
    const stepRows = steps.map((step, index) => ({
      id: uuidv4(),
      script_id: scriptId,
      step_index: index,
      content: step.content,
      internal_note: step.internalNote || null,
      media_urls: step.mediaUrls || [],
      is_ppv: step.isPpv || false,
      ppv_price: step.ppvPrice || null,
      delay_seconds: step.delaySeconds || 0
    }));

    const { error: stepsError } = await supabase.from('script_steps').insert(stepRows);
    if (stepsError) throw stepsError;

    res.status(201).json({ scriptId, message: 'Script created' });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/scripts/:scriptId
 * Update script metadata + replace steps
 */
router.patch('/:scriptId', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { name, description, status, steps } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status) updates.status = status;
    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('scripts')
      .update(updates)
      .eq('id', req.params.scriptId)
      .eq('organization_id', req.user.organization_id);

    if (error) throw error;

    // If steps provided, replace all
    if (steps) {
      await supabase.from('script_steps').delete().eq('script_id', req.params.scriptId);

      const stepRows = steps.map((step, index) => ({
        id: uuidv4(),
        script_id: req.params.scriptId,
        step_index: index,
        content: step.content,
        internal_note: step.internalNote || null,
        media_urls: step.mediaUrls || [],
        is_ppv: step.isPpv || false,
        ppv_price: step.ppvPrice || null,
        delay_seconds: step.delaySeconds || 0
      }));

      await supabase.from('script_steps').insert(stepRows);
    }

    res.json({ message: 'Script updated' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/scripts/:scriptId (archive)
 */
router.delete('/:scriptId', authenticate, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    await supabase
      .from('scripts')
      .update({ status: 'archived' })
      .eq('id', req.params.scriptId)
      .eq('organization_id', req.user.organization_id);

    res.json({ message: 'Script archived' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// SCRIPT RUNNER (Chatters can use)
// ============================================================

/**
 * POST /api/scripts/:scriptId/run
 * Start a script run for a fan conversation
 */
router.post('/:scriptId/run', authenticate, async (req, res, next) => {
  try {
    const { conversationId, fanId, accountId } = req.body;

    if (!conversationId || !fanId) {
      return res.status(400).json({ error: 'conversationId and fanId required' });
    }

    // Check for existing active run
    const { data: existingRun } = await supabase
      .from('script_runs')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .single();

    if (existingRun) {
      return res.status(409).json({ error: 'Script already running in this conversation', runId: existingRun.id });
    }

    // Get script with steps
    const { data: script, error } = await supabase
      .from('scripts')
      .select('*, script_steps(*)')
      .eq('id', req.params.scriptId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !script) return res.status(404).json({ error: 'Script not found' });
    if (script.status !== 'published') return res.status(400).json({ error: 'Script must be published to run' });

    const steps = script.script_steps.sort((a, b) => a.step_index - b.step_index);

    // Create run
    const runId = uuidv4();
    const { error: runError } = await supabase
      .from('script_runs')
      .insert({
        id: runId,
        script_id: req.params.scriptId,
        account_id: accountId,
        fan_id: fanId,
        conversation_id: conversationId,
        chatter_id: req.user.id,
        current_step: 0,
        status: 'active',
        started_at: new Date().toISOString()
      });

    if (runError) throw runError;

    // Update script run count
    await supabase
      .from('scripts')
      .update({ run_count: script.run_count + 1 })
      .eq('id', req.params.scriptId);

    res.status(201).json({
      runId,
      currentStep: 0,
      steps: steps.map(s => ({
        index: s.step_index,
        content: s.content,
        internalNote: s.internal_note,
        isPpv: s.is_ppv,
        ppvPrice: s.ppv_price,
        delaySeconds: s.delay_seconds,
        mediaUrls: s.media_urls
      }))
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scripts/runs/:runId/advance
 * Advance to next step (after sending current step)
 */
router.post('/runs/:runId/advance', authenticate, async (req, res, next) => {
  try {
    const { action = 'step_sent', messageId, revenueAmount } = req.body;

    const { data: run, error } = await supabase
      .from('script_runs')
      .select('*, script:scripts(*, script_steps(*))')
      .eq('id', req.params.runId)
      .single();

    if (error || !run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'active') return res.status(400).json({ error: 'Run is not active' });

    const steps = run.script.script_steps.sort((a, b) => a.step_index - b.step_index);
    const isLastStep = run.current_step >= steps.length - 1;

    // Log event
    await supabase.from('script_run_events').insert({
      id: uuidv4(),
      run_id: req.params.runId,
      step_index: run.current_step,
      action,
      fanvue_message_id: messageId || null,
      revenue_amount: revenueAmount || null,
      created_at: new Date().toISOString()
    });

    if (isLastStep || action === 'completed') {
      // Complete the run
      await supabase
        .from('script_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          converted: revenueAmount > 0
        })
        .eq('id', req.params.runId);

      return res.json({ status: 'completed', message: 'Script completed!' });
    }

    const nextStep = run.current_step + 1;
    await supabase
      .from('script_runs')
      .update({
        current_step: nextStep,
        last_step_at: new Date().toISOString()
      })
      .eq('id', req.params.runId);

    res.json({
      status: 'active',
      currentStep: nextStep,
      nextStep: steps[nextStep] ? {
        index: steps[nextStep].step_index,
        content: steps[nextStep].content,
        internalNote: steps[nextStep].internal_note,
        isPpv: steps[nextStep].is_ppv,
        ppvPrice: steps[nextStep].ppv_price,
        delaySeconds: steps[nextStep].delay_seconds
      } : null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scripts/runs/:runId/abandon
 */
router.post('/runs/:runId/abandon', authenticate, async (req, res, next) => {
  try {
    const { data: run } = await supabase
      .from('script_runs')
      .select('id, current_step')
      .eq('id', req.params.runId)
      .single();

    if (!run) return res.status(404).json({ error: 'Run not found' });

    await supabase.from('script_run_events').insert({
      id: uuidv4(),
      run_id: req.params.runId,
      step_index: run.current_step,
      action: 'abandoned',
      created_at: new Date().toISOString()
    });

    await supabase
      .from('script_runs')
      .update({ status: 'abandoned', completed_at: new Date().toISOString() })
      .eq('id', req.params.runId);

    res.json({ message: 'Run abandoned' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scripts/:scriptId/analytics
 */
router.get('/:scriptId/analytics', authenticate, async (req, res, next) => {
  try {
    const { data: runs } = await supabase
      .from('script_runs')
      .select('id, status, converted, revenue_generated, started_at, completed_at, chatter_id, chatter:users(name)')
      .eq('script_id', req.params.scriptId)
      .order('started_at', { ascending: false })
      .limit(100);

    if (!runs) return res.json({ analytics: null });

    const total = runs.length;
    const completed = runs.filter(r => r.status === 'completed').length;
    const converted = runs.filter(r => r.converted).length;
    const totalRevenue = runs.reduce((sum, r) => sum + (r.revenue_generated || 0), 0);

    // By chatter
    const byChatter = {};
    runs.forEach(r => {
      if (!r.chatter_id) return;
      if (!byChatter[r.chatter_id]) {
        byChatter[r.chatter_id] = { name: r.chatter?.name, runs: 0, converted: 0, revenue: 0 };
      }
      byChatter[r.chatter_id].runs++;
      if (r.converted) byChatter[r.chatter_id].converted++;
      byChatter[r.chatter_id].revenue += r.revenue_generated || 0;
    });

    res.json({
      analytics: {
        totalRuns: total,
        completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
        conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
        totalRevenue,
        avgRevenuePerRun: total > 0 ? (totalRevenue / total).toFixed(2) : 0,
        byChatter: Object.values(byChatter)
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
