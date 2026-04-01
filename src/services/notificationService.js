/**
 * NotificationService — Central dispatcher
 *
 * Handles: email | sms | whatsapp | push | in_app
 * - Logs every attempt in the notifications table
 * - Retries on transient failures (up to MAX_RETRIES)
 * - Supports template-based and raw notifications
 */

const { query } = require('../data/db');
const logger    = require('../utils/logger');

const { sendEmail, TEMPLATES: EMAIL_TEMPLATES, interpolate } = require('./emailService');
const { sendSms, SMS_TEMPLATES }                             = require('./smsService');
const { sendWhatsApp, WA_TEMPLATES }                         = require('./whatsappService');
const { sendPush, sendPushMulticast, sendPushTopic, PUSH_PAYLOADS } = require('./pushService');

const MAX_RETRIES = 2;

// ─── Core send function ───────────────────────────────────

/**
 * Send a notification through the specified channel.
 * Creates a log entry and updates it after delivery.
 *
 * @param {object} opts
 * @param {string}  opts.channel      - 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app'
 * @param {string}  opts.type         - template key (e.g. 'visit_confirmation')
 * @param {string}  opts.recipient    - email address, phone number, or FCM token
 * @param {object}  [opts.vars]       - interpolation variables
 * @param {string}  [opts.subject]    - override subject (email only)
 * @param {string}  [opts.body]       - override body (raw mode)
 * @param {string}  [opts.relatedType]- 'client' | 'lead' | 'visit' | 'payment' | 'ticket'
 * @param {string}  [opts.relatedId]  - UUID of related entity
 * @param {string}  [opts.sentBy]     - internal user id (for manual sends)
 * @param {string}  [opts.templateId] - notification_templates.id (if from DB template)
 */
const send = async (opts) => {
  const {
    channel, type, recipient, vars = {},
    subject: overrideSubject, body: overrideBody,
    relatedType, relatedId, sentBy, templateId,
  } = opts;

  let resolvedSubject = overrideSubject || '';
  let resolvedContent = overrideBody    || '';

  // ── Resolve content from built-in templates ───────────
  if (!overrideBody) {
    resolvedContent = resolveContent(channel, type, vars, resolvedContent);
    resolvedSubject = resolvedSubject || resolveSubject(channel, type, vars);
  }

  // ── Insert pending log entry ──────────────────────────
 const logRes = await query(
  `INSERT INTO notification_queue
     (channel, type, recipient, subject, content, variables,
      related_type, related_id, status, sent_by, scheduled_at, attempts, max_attempts)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,NOW(),0,$10)
   RETURNING id`,
  [
    channel,
    type,
    recipient,
    resolvedSubject || null,
    resolvedContent || null,
    vars || {},
    relatedType || null,
    relatedId || null,
    sentBy || null,
    MAX_RETRIES + 1,
  ]
);

  const notifId = logRes.rows[0].id;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      let result;

      switch (channel) {
        case 'email':
          result = await sendEmail({
            to: recipient, subject: resolvedSubject,
            html: resolvedContent, vars,
          });
          break;

        case 'sms':
          result = await sendSms({ to: recipient, body: resolvedContent, vars });
          break;

        case 'whatsapp':
          result = await sendWhatsApp({ to: recipient, body: resolvedContent, vars });
          break;

        case 'push': {
          const payload = PUSH_PAYLOADS[type]?.(vars) || {
            title: resolvedSubject || 'Ikadou',
            body:  resolvedContent,
            data:  {},
          };
          result = await sendPush({ token: recipient, ...payload });
          break;
        }

        case 'in_app':
          // In-app: stored in DB, polled or websocket-delivered by app
          result = { status: 'sent' };
          break;

        default:
          throw new Error(`Canal inconnu: ${channel}`);
      }

      // ── Mark as sent ────────────────────────────────
      await query(
  `UPDATE notification_queue
   SET status = 'sent', processed_at = NOW(), attempts = $2
   WHERE id = $1`,
  [notifId, attempt + 1]
);

      logger.info(`[NOTIF] ${channel.toUpperCase()} sent — type: ${type} to: ${recipient}`);
      return { success: true, notifId, result };

    } catch (err) {
      attempt++;
      logger.warn(`[NOTIF] ${channel} attempt ${attempt}/${MAX_RETRIES + 1} failed: ${err.message}`);

      if (attempt > MAX_RETRIES) {
       await query(
  `UPDATE notification_queue
   SET status = 'failed',
       error_reason = $2,
       processed_at = NOW(),
       attempts = $3
   WHERE id = $1`,
  [notifId, err.message?.substring(0, 500), attempt, attempt]
);
        logger.error(`[NOTIF] ${channel} FAILED after ${attempt} attempts — type: ${type} to: ${recipient}`);
        return { success: false, notifId, error: err.message };
      }

      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
};

// ─── Multi-channel broadcast ──────────────────────────────

/**
 * Send a notification across multiple channels simultaneously.
 * @param {object} opts
 * @param {string[]} opts.channels   - ['email','sms','whatsapp','push']
 * @param {object}   opts.recipients - { email, phone, pushToken }
 * @param {string}   opts.type
 * @param {object}   [opts.vars]
 * @param {string}   [opts.relatedType]
 * @param {string}   [opts.relatedId]
 * @param {string}   [opts.sentBy]
 */
const sendMultiChannel = async (opts) => {
  const { channels, recipients, type, vars = {}, relatedType, relatedId, sentBy } = opts;

  const promises = channels.map(channel => {
    const recipient =
      channel === 'email'    ? recipients.email     :
      channel === 'sms'      ? recipients.phone      :
      channel === 'whatsapp' ? recipients.phone      :
      channel === 'push'     ? recipients.pushToken  :
      null;

    if (!recipient) {
      logger.debug(`[NOTIF] No recipient for channel ${channel}, skipping`);
      return Promise.resolve(null);
    }

    return send({ channel, type, recipient, vars, relatedType, relatedId, sentBy });
  });

  const results = await Promise.allSettled(promises);
  return results.map((r, i) => ({
    channel: channels[i],
    ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }),
  }));
};

// ─── Topic broadcast (push only) ─────────────────────────

const broadcastPush = async ({ topic, type, vars = {}, sentBy }) => {
  const payload = PUSH_PAYLOADS[type]?.(vars) || {
    title: 'Ikadou',
    body:  vars.message || '',
  };

  const result = await sendPushTopic({ topic, ...payload });

  await query(
    `INSERT INTO notifications (type, channel, recipient, subject, content, status, sent_by, sent_at)
     VALUES ($1, 'push', $2, $3, $4, 'sent', $5, NOW())`,
    [type, `topic:${topic}`, payload.title, payload.body, sentBy || null]
  );

  return result;
};

// ─── Helpers ──────────────────────────────────────────────

const resolveContent = (channel, type, vars, fallback) => {
  if (fallback) return interpolate(fallback, vars);

  if (channel === 'email') {
    const tpl = EMAIL_TEMPLATES[type]?.(vars);
    return tpl?.html ? interpolate(tpl.html, vars) : fallback;
  }
  if (channel === 'sms') {
    const tpl = SMS_TEMPLATES[type];
    return tpl ? interpolate(tpl(), vars) : fallback;
  }
  if (channel === 'whatsapp') {
    const tpl = WA_TEMPLATES[type];
    return tpl ? interpolate(tpl(), vars) : fallback;
  }
  if (channel === 'push') {
    const p = PUSH_PAYLOADS[type]?.(vars);
    return p?.body || fallback;
  }
  return fallback;
};

const resolveSubject = (channel, type, vars) => {
  if (channel === 'email') {
    const tpl = EMAIL_TEMPLATES[type]?.(vars);
    return tpl?.subject ? interpolate(tpl.subject, vars) : type;
  }
  if (channel === 'push') {
    return PUSH_PAYLOADS[type]?.(vars)?.title || 'Ikadou';
  }
  return type;
};

// ─── Convenience helpers ──────────────────────────────────

/**
 * Notify after a visit is confirmed.
 */
const notifyVisitConfirmed = async ({ client, visit, terrain, agent, sentBy }) => {
  const vars = {
    first_name:    client.first_name,
    terrain_title: terrain.title,
    visit_date:    visit.visit_date,
    visit_time:    visit.visit_time?.substring(0, 5),
    agent_name:    agent ? `${agent.first_name} ${agent.last_name}` : 'Notre équipe',
    agent_phone:   agent?.phone || '',
    visit_id:      visit.id,
  };

  const recipients = {
    email:     client.email,
    phone:     client.phone,
    pushToken: client.push_token,
  };

  const channels = ['email', 'sms', 'push'].filter(c =>
    (c === 'email' && client.email) ||
    (c === 'sms'   && client.phone) ||
    (c === 'push'  && client.push_token)
  );

  return sendMultiChannel({ channels, recipients, type: 'visit_confirmation', vars, relatedType: 'visit', relatedId: visit.id, sentBy });
};

/**
 * Notify after a payment is confirmed.
 */
const notifyPaymentConfirmed = async ({ client, payment, terrain, sentBy }) => {
  const vars = {
    first_name:    client.first_name,
    payment_ref:   payment.ref,
    amount:        new Intl.NumberFormat('fr-FR').format(payment.amount),
    currency:      payment.currency,
    terrain_title: terrain?.title || '',
    payment_date:  new Date(payment.created_at).toLocaleDateString('fr-FR'),
    payment_id:    payment.id,
  };

  const channels = ['email', 'sms'].filter(c =>
    (c === 'email' && client.email) ||
    (c === 'sms'   && client.phone)
  );

  return sendMultiChannel({
    channels,
    recipients: { email: client.email, phone: client.phone },
    type: 'payment_confirmed', vars,
    relatedType: 'payment', relatedId: payment.id, sentBy,
  });
};

/**
 * Notify on ticket opened.
 */
const notifyTicketOpened = async ({ client, ticket, sentBy }) => {
  const vars = {
    first_name:  client.first_name,
    ticket_ref:  ticket.ref,
    subject:     ticket.subject,
    priority:    ticket.priority,
    ticket_id:   ticket.id,
  };

  return sendMultiChannel({
    channels:   ['email'],
    recipients: { email: client.email },
    type: 'ticket_opened', vars,
    relatedType: 'ticket', relatedId: ticket.id, sentBy,
  });
};

module.exports = {
  send,
  sendMultiChannel,
  broadcastPush,
  notifyVisitConfirmed,
  notifyPaymentConfirmed,
  notifyTicketOpened,
};