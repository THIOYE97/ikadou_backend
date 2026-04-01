const config = require('../config/env');
const logger = require('../utils/logger');

let _app = null;

const getFirebase = () => {
  if (_app) return _app;
  const { projectId, clientEmail, privateKey } = config.firebase;
  if (!projectId || !clientEmail || !privateKey) return null;

  try {
    const admin = require('firebase-admin');
    if (admin.apps.length) { _app = admin.apps[0]; return _app; }
    _app = admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
    return _app;
  } catch (err) {
    logger.warn(`[Push] Firebase init failed: ${err.message}`);
    return null;
  }
};

// ─── Push payloads per event type ────────────────────────
const PUSH_PAYLOADS = {
  visit_confirmation: (v) => ({
    title: '✅ Visite confirmée',
    body:  `Votre visite pour ${v.terrain_title} est confirmée le ${v.visit_date} à ${v.visit_time}`,
    data:  { type: 'visit', visitId: v.visit_id || '', screen: 'VisitDetail' },
  }),
  visit_reminder: (v) => ({
    title: '🔔 Rappel de visite',
    body:  `Votre visite ${v.terrain_title} est demain à ${v.visit_time}`,
    data:  { type: 'visit', visitId: v.visit_id || '', screen: 'VisitDetail' },
  }),
  visit_cancelled: (v) => ({
    title: '❌ Visite annulée',
    body:  `Votre visite ${v.terrain_title} du ${v.visit_date} a été annulée`,
    data:  { type: 'visit', screen: 'Visits' },
  }),
  payment_confirmed: (v) => ({
    title: '💳 Paiement confirmé',
    body:  `Paiement ${v.payment_ref} de ${v.amount} ${v.currency} confirmé`,
    data:  { type: 'payment', paymentId: v.payment_id || '', screen: 'PaymentDetail' },
  }),
  payment_failed: (v) => ({
    title: '⚠️ Paiement échoué',
    body:  `Votre paiement ${v.payment_ref} n'a pas abouti`,
    data:  { type: 'payment', screen: 'Payments' },
  }),
  ticket_opened: (v) => ({
    title: '🎫 Support — Ticket créé',
    body:  `Ticket ${v.ticket_ref} : ${v.subject}`,
    data:  { type: 'ticket', ticketId: v.ticket_id || '', screen: 'TicketDetail' },
  }),
  ticket_resolved: (v) => ({
    title: '✅ Demande résolue',
    body:  `Votre demande ${v.ticket_ref} a été résolue`,
    data:  { type: 'ticket', screen: 'Tickets' },
  }),
  new_terrain: (v) => ({
    title: '🏡 Nouveau terrain disponible',
    body:  `${v.terrain_title} — ${v.price} ${v.currency}`,
    data:  { type: 'terrain', terrainId: v.terrain_id || '', screen: 'TerrainDetail' },
  }),
  custom: (v) => ({
    title: v.title || 'Ikadou',
    body:  v.body  || '',
    data:  v.data  || {},
  }),
};

// ─── Send push to a single device token ──────────────────
const sendPush = async ({ token, title, body, data = {} }) => {
  if (!config.notifications.pushEnabled) {
    logger.info(`[Push] Disabled — skip ${token?.substring(0, 20)}...`);
    return { messageId: 'disabled', skipped: true };
  }
  const app = getFirebase();
  if (!app) {
    logger.warn('[Push] Firebase not configured');
    return { messageId: 'unconfigured', skipped: true };
  }

  const admin = require('firebase-admin');
  const message = {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    token,
    android: { priority: 'high', notification: { sound: 'default', clickAction: 'FLUTTER_NOTIFICATION_CLICK' } },
    apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
  };

  const result = await admin.messaging(app).send(message);
  logger.info(`[Push] Sent — messageId: ${result}`);
  return { messageId: result };
};

// ─── Multicast (up to 500 tokens) ────────────────────────
const sendPushMulticast = async ({ tokens, title, body, data = {} }) => {
  if (!tokens?.length) return { successCount: 0, failureCount: 0 };
  if (!config.notifications.pushEnabled) return { successCount: 0, failureCount: 0, skipped: true };

  const app = getFirebase();
  if (!app) return { successCount: 0, failureCount: 0, skipped: true };

  const admin = require('firebase-admin');
  const message = {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    tokens,
    android: { priority: 'high' },
    apns:    { payload: { aps: { sound: 'default' } } },
  };

  const res = await admin.messaging(app).sendEachForMulticast(message);
  logger.info(`[Push] Multicast ${tokens.length} tokens — success: ${res.successCount} fail: ${res.failureCount}`);
  return { successCount: res.successCount, failureCount: res.failureCount };
};

// ─── Topic broadcast ──────────────────────────────────────
const sendPushTopic = async ({ topic, title, body, data = {} }) => {
  if (!config.notifications.pushEnabled) return { messageId: 'disabled', skipped: true };
  const app = getFirebase();
  if (!app) return { messageId: 'unconfigured', skipped: true };

  const admin = require('firebase-admin');
  const result = await admin.messaging(app).send({
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    topic,
  });
  logger.info(`[Push] Topic "${topic}" — messageId: ${result}`);
  return { messageId: result };
};

module.exports = { sendPush, sendPushMulticast, sendPushTopic, PUSH_PAYLOADS };

