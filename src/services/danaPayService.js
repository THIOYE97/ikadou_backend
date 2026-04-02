/**
 * DanaPay Service — Ikadou
 *
 * DanaPay is a payment infrastructure for Africa (Mobile Money, Wave, etc.)
 * Supports: XOF, GNF, XAF
 * Countries: Mali, Senegal, Guinea, Côte d'Ivoire, Cameroun, ...
 *
 * Docs: https://docs.danapay.io
 * Methods: Orange Money, Wave, Free Money, Moov Money, MTN, bank transfer
 */

const axios   = require('axios');
const crypto  = require('crypto');
const config  = require('../config/env');
const logger  = require('../utils/logger');

// ─── Axios client singleton ──────────────────────────────

let _client = null;

const getClient = () => {
  if (_client) return _client;

  const { apiKey, apiSecret, baseUrl } = config.danapay || {};

  if (!apiKey || !apiSecret) {
    logger.warn('[DanaPay] API credentials not configured');
    return null;
  }

  // DanaPay uses Basic Auth: base64(apiKey:apiSecret)
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  _client = axios.create({
    baseURL: baseUrl || 'https://api.danapay.io/v1',
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    timeout: 30000,
  });

  // Response interceptor for logging
  _client.interceptors.response.use(
    (res) => { logger.debug(`[DanaPay] ${res.config.method?.toUpperCase()} ${res.config.url} → ${res.status}`); return res; },
    (err) => {
      const msg = err.response?.data?.message || err.message;
      logger.error(`[DanaPay] Error: ${msg}`, { status: err.response?.status, url: err.config?.url });
      throw new Error(msg || 'DanaPay request failed');
    }
  );

  return _client;
};

// ─── Supported mobile money operators ────────────────────

const OPERATORS = {
  orange_money: { label: 'Orange Money',  countries: ['ML','SN','CI','GN','CM'] },
  wave:         { label: 'Wave',           countries: ['ML','SN','CI'] },
  free_money:   { label: 'Free Money',     countries: ['SN'] },
  moov_money:   { label: 'Moov Money',     countries: ['CI','BJ','TG','BF','NE'] },
  mtn_momo:     { label: 'MTN Mobile Money', countries: ['CI','GN','CM'] },
};

const getOperatorsByCountry = (countryCode) =>
  Object.entries(OPERATORS)
    .filter(([, op]) => op.countries.includes(countryCode?.toUpperCase()))
    .map(([key, op]) => ({ key, label: op.label }));

// ─── Create Transfer (charge) ────────────────────────────

/**
 * Initiate a Mobile Money payment request.
 * The customer receives a prompt on their phone to validate.
 *
 * @param {object} opts
 * @param {number}  opts.amount         - Amount in XOF (or configured currency)
 * @param {string}  opts.phone          - Customer phone number (+223XXXXXXXX)
 * @param {string}  opts.operator       - 'orange_money' | 'wave' | 'free_money' | etc.
 * @param {string}  opts.description    - Payment description
 * @param {string}  opts.paymentId      - Internal payment UUID
 * @param {string}  opts.clientName
 * @param {string}  [opts.currency]     - XOF | GNF | XAF (default: XOF)
 * @param {string}  [opts.callbackUrl]  - Webhook URL for status updates
 */
const createTransfer = async ({
  amount, phone, operator, description,
  paymentId, clientName, currency, callbackUrl,
}) => {
  const client = getClient();
  if (!client) throw new Error('DanaPay non configuré');

  const payload = {
    amount:       Math.round(amount),
    currency:     currency || config.danapay.currency || 'XOF',
    phone_number: phone.replace(/\s+/g, ''),
    operator:     operator || 'orange_money',
    description:  description || 'Paiement Ikadou',
    reference:    paymentId,
    customer: {
      name:  clientName || 'Client Ikadou',
      phone: phone.replace(/\s+/g, ''),
    },
    callback_url: callbackUrl || `${config.payment.callbackBaseUrl}/api/v1/webhooks/danapay`,
    metadata: { payment_id: paymentId },
  };

  const res = await client.post('/transfers', payload);
  const data = res.data;

  logger.info(`[DanaPay] Transfer initiated: ${data.id} — ${amount} XOF via ${operator}`);

  return {
    transferId:    data.id,
    status:        data.status,       // 'pending' | 'processing' | 'success' | 'failed'
    providerRef:   data.id,
    checkoutUrl:   data.payment_url || null,  // Optional redirect URL for some operators
    amount,
    currency:      payload.currency,
    operator,
    raw: data,
  };
};

// ─── Create Payment Link (hosted checkout) ───────────────

/**
 * Create a hosted payment link that customers can open to choose their operator.
 * Works well for web/email flows where you don't know the operator in advance.
 */
const createPaymentLink = async ({
  amount, clientEmail, clientName, description,
  paymentId, terrainTitle, currency,
}) => {
  const client = getClient();
  if (!client) throw new Error('DanaPay non configuré');

  const payload = {
    amount:      Math.round(amount),
    currency:    currency || config.danapay.currency || 'XOF',
    description: description || `Terrain — ${terrainTitle}`,
    reference:   paymentId,
    customer: {
      name:  clientName || 'Client Ikadou',
      email: clientEmail || '',
    },
    success_url: `${config.payment.successUrl}?payment_id=${paymentId}`,
    cancel_url:  `${config.payment.cancelUrl}?payment_id=${paymentId}`,
    callback_url: `${config.payment.callbackBaseUrl}/api/v1/webhooks/danapay`,
    expires_in:  1800, // 30 min
    metadata: { payment_id: paymentId },
  };

  const res = await client.post('/payment-links', payload);
  const data = res.data;

  logger.info(`[DanaPay] Payment link created: ${data.id}`);

  return {
    linkId:      data.id,
    checkoutUrl: data.url,
    expiresAt:   data.expires_at ? new Date(data.expires_at) : null,
    amount,
    currency:    payload.currency,
    raw: data,
  };
};

// ─── Retrieve Transfer ───────────────────────────────────

const retrieveTransfer = async (transferId) => {
  const client = getClient();
  if (!client) throw new Error('DanaPay non configuré');
  const res = await client.get(`/transfers/${transferId}`);
  return res.data;
};

// ─── Initiate Refund ─────────────────────────────────────

/**
 * @param {string} transferId  - DanaPay transfer ID
 * @param {number} [amount]    - Partial refund (omit for full)
 * @param {string} [reason]
 */
const createRefund = async (transferId, amount, reason = 'customer_request') => {
  const client = getClient();
  if (!client) throw new Error('DanaPay non configuré');

  const payload = { reason, ...(amount && { amount: Math.round(amount) }) };
  const res = await client.post(`/transfers/${transferId}/refund`, payload);

  logger.info(`[DanaPay] Refund initiated for transfer: ${transferId}`);
  return res.data;
};

// ─── Webhook signature verification ─────────────────────

/**
 * DanaPay signs webhooks with HMAC-SHA256.
 * Header: X-DanaPay-Signature
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!config.danapay?.webhookSecret) {
    logger.warn('[DanaPay] Webhook secret not configured — skipping verification');
    return true;
  }

  const expected = crypto
    .createHmac('sha256', config.danapay.webhookSecret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature || ''),
    Buffer.from(expected)
  );
};

// ─── Map DanaPay status to internal status ────────────────

const mapDanaPayStatus = (danaPayStatus) => {
  const map = {
    pending:    'pending',
    processing: 'pending',
    success:    'confirmed',
    failed:     'failed',
    cancelled:  'cancelled',
    refunded:   'refunded',
    expired:    'cancelled',
  };
  return map[danaPayStatus] || 'pending';
};

module.exports = {
  createTransfer,
  createPaymentLink,
  retrieveTransfer,
  createRefund,
  verifyWebhookSignature,
  mapDanaPayStatus,
  getOperatorsByCountry,
  OPERATORS,
};