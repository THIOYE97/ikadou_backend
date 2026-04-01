const config = require('../config/env');
const logger  = require('../utils/logger');

let _client = null;

const getClient = () => {
  if (_client) return _client;
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  const twilio = require('twilio');
  _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
};

// ─── Normalize phone ──────────────────────────────────────
const normalizePhone = (phone) => {
  if (!phone) return null;
  const clean = phone.replace(/\s+/g, '').replace(/^00/, '+');
  return clean.startsWith('+') ? clean : `+${clean}`;
};

// ─── Interpolation ────────────────────────────────────────
const interpolate = (str, vars = {}) => {
  if (!str) return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
};

// ─── SMS templates ────────────────────────────────────────
const SMS_TEMPLATES = {
  visit_confirmation: () =>
    `[Ikadou] Visite confirmée : {{terrain_title}} le {{visit_date}} à {{visit_time}}. Agent : {{agent_name}} {{agent_phone}}`,
  visit_reminder: () =>
    `[Ikadou] Rappel : votre visite {{terrain_title}} est demain à {{visit_time}}. Agent : {{agent_phone}}`,
  visit_cancelled: () =>
    `[Ikadou] Votre visite {{terrain_title}} du {{visit_date}} a été annulée. Contactez-nous : {{support_phone}}`,
  payment_confirmed: () =>
    `[Ikadou] Paiement {{payment_ref}} de {{amount}} {{currency}} confirmé. Merci de votre confiance !`,
  payment_pending: () =>
    `[Ikadou] Paiement {{payment_ref}} reçu, en cours de validation. Réf : {{payment_ref}}`,
  ticket_opened: () =>
    `[Ikadou] Ticket {{ticket_ref}} créé : "{{subject}}". Notre équipe vous répond bientôt.`,
  ticket_resolved: () =>
    `[Ikadou] Votre demande {{ticket_ref}} a été résolue. Merci de votre patience.`,
  lead_assigned: () =>
    `[Ikadou] Votre agent {{agent_name}} vous contactera prochainement au {{agent_phone}}`,
  otp: () =>
    `[Ikadou] Votre code de vérification : {{code}} (valable 10 min). Ne le partagez pas.`,
};

// ─── Send SMS ─────────────────────────────────────────────
const sendSms = async ({ to, body, type, vars = {} }) => {
  if (!config.notifications.smsEnabled) {
    logger.info(`[SMS] Disabled — skip ${to}`); return { sid: 'disabled', skipped: true };
  }

  const client = getClient();
  if (!client) {
    logger.warn('[SMS] Twilio not configured'); return { sid: 'unconfigured', skipped: true };
  }

  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Numéro invalide: ${to}`);

  let resolvedBody = body;
  if (type && SMS_TEMPLATES[type] && !body) {
    resolvedBody = SMS_TEMPLATES[type]();
  }
  resolvedBody = interpolate(resolvedBody || '', vars);

  const msg = await client.messages.create({
    body: resolvedBody,
    from: config.twilio.smsFrom,
    to:   phone,
  });

  logger.info(`[SMS] Sent to ${phone} — SID: ${msg.sid}`);
  return { sid: msg.sid };
};

module.exports = { sendSms, normalizePhone, interpolate, SMS_TEMPLATES };


