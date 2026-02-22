const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');

const router = express.Router();

/**
 * Verify Fanvue webhook signature
 * Header format: X-Fanvue-Signature: t=<timestamp>,v0=<hmac-sha256>
 */
function verifySignature(rawBody, header) {
  const secret = process.env.FANVUE_WEBHOOK_SECRET;
  if (!secret || !header) return false;

  const parts = {};
  header.split(',').forEach(part => {
    const [k, v] = part.split('=');
    parts[k] = v;
  });

  const { t, v0 } = parts;
  if (!t || !v0) return false;

  // Reject if timestamp is older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(t)) > 300) return false;

  const payload = `${t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v0), Buffer.from(expected));
}

/**
 * POST /api/webhooks/fanvue
 * Receives real-time events from Fanvue
 * Events: message.received, follower.new, subscriber.new, purchase.received, tip.received
 */
router.post('/fanvue', express.raw({ type: 'application/json' }), async (req, res) => {
  // Always respond 200 immediately so Fanvue doesn't retry
  res.status(200).json({ received: true });

  try {
    const sig = req.headers['x-fanvue-signature'];
    const rawBody = req.body.toString();

    // Verify signature if secret is configured
    if (process.env.FANVUE_WEBHOOK_SECRET && !verifySignature(rawBody, sig)) {
      console.warn('[Webhook] Invalid signature — ignoring');
      return;
    }

    const payload = JSON.parse(rawBody);
    const { event, data } = payload;

    console.log('[Webhook] Fanvue event:', event);

    switch (event) {
      case 'message.received': {
        const fanUuid = data?.sender?.uuid || data?.from?.uuid || data?.userUuid;
        if (!fanUuid) break;

        const { data: conv } = await supabase
          .from('conversations')
          .select('id, organization_id')
          .eq('fanvue_thread_id', fanUuid)
          .single();

        if (!conv) break;

        // Upsert the inbound message
        await supabase.from('messages').upsert({
          conversation_id: conv.id,
          organization_id: conv.organization_id,
          fanvue_message_id: data?.uuid,
          direction: 'inbound',
          content: data?.text || null,
          platform_status: 'delivered',
          sent_at: data?.sentAt || new Date().toISOString()
        }, { onConflict: 'fanvue_message_id', ignoreDuplicates: true });

        // Update conversation
        await supabase.from('conversations').update({
          is_unread: true,
          last_message_at: data?.sentAt || new Date().toISOString(),
          last_message_preview: data?.text?.substring(0, 100) || '[Media]',
          last_message_from: 'fan',
          updated_at: new Date().toISOString()
        }).eq('id', conv.id);

        break;
      }

      case 'subscriber.new': {
        const fanUuid = data?.subscriber?.uuid || data?.userUuid;
        if (!fanUuid) break;

        // Update fan subscription status if they exist
        await supabase.from('fans')
          .update({ subscription_status: 'active', updated_at: new Date().toISOString() })
          .eq('fanvue_fan_id', fanUuid);

        break;
      }

      case 'purchase.received':
      case 'tip.received': {
        console.log(`[Webhook] ${event}:`, data?.amount, data?.currency);
        // Future: record in revenue table
        break;
      }

      default:
        console.log('[Webhook] Unhandled event type:', event);
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

module.exports = router;
