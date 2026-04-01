const config   = require('../config/env');
const logger   = require('../utils/logger');
const { interpolate, normalizePhone } = require('./smsService');

let _client = null;
const getClient = () => {
  if (_client) return _client;
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  const twilio = require('twilio');
  _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
};

const WA_TEMPLATES = {
  visit_confirmation: () =>
    `🏡 *Ikadou — Visite confirmée*\n\nBonjour {{first_name}} !\n\nVotre visite est confirmée :\n📍 *Terrain :* {{terrain_title}}\n📅 *Date :* {{visit_date}} à {{visit_time}}\n👤 *Agent :* {{agent_name}}\n📞 {{agent_phone}}\n\nBonne visite ! 🌍`,
  payment_confirmed: () =>
    `✅ *Ikadou — Paiement confirmé*\n\nBonjour {{first_name}},\n\nVotre paiement a bien été reçu :\n💳 Réf : *{{payment_ref}}*\n💰 Montant : *{{amount}} {{currency}}*\n🏡 Terrain : {{terrain_title}}\n\nMerci de votre confiance ! 🙏`,
  ticket_resolved: () =>
    `✅ *Ikadou — Demande résolue*\n\nBonjour {{first_name}},\n\nVotre demande *{{ticket_ref}}* a été traitée. N'hésitez pas à nous contacter si besoin.`,
};

const sendWhatsApp = async ({ to, body, type, vars = {} }) => {
  if (!config.notifications.whatsappEnabled) {
    logger.info(`[WhatsApp] Disabled — skip ${to}`); return { sid: 'disabled', skipped: true };
  }
  const client = getClient();
  if (!client) {
    logger.warn('[WhatsApp] Twilio not configured'); return { sid: 'unconfigured', skipped: true };
  }

  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Numéro invalide: ${to}`);

  let resolvedBody = body;
  if (type && WA_TEMPLATES[type] && !body) resolvedBody = WA_TEMPLATES[type]();
  resolvedBody = interpolate(resolvedBody || '', vars);

  const msg = await client.messages.create({
    body: resolvedBody,
    from: config.twilio.waFrom,
    to:   `whatsapp:${phone}`,
  });

  logger.info(`[WhatsApp] Sent to ${phone} — SID: ${msg.sid}`);
  return { sid: msg.sid };
};

module.exports = { sendWhatsApp, WA_TEMPLATES };
