/**
 * Stripe Service — Ikadou
 *
 * Handles:
 * - Payment Intent (one-shot)
 * - Checkout Session (hosted page)
 * - Refunds
 * - Webhook signature verification
 *
 * Currency strategy:
 *   Stripe does not natively support XOF.
 *   We store amounts in XOF but charge in EUR/USD using a live rate.
 *   For now the rate is configurable; plug in an exchange API for production.
 */

const config = require('../config/env');
const logger  = require('../utils/logger');

let _stripe = null;

const getStripe = () => {
  if (_stripe) return _stripe;
  if (!config.stripe?.secretKey) {
    logger.warn('[Stripe] Secret key not configured');
    return null;
  }
  _stripe = require('stripe')(config.stripe.secretKey);
  return _stripe;
};

// ─── XOF → EUR conversion (approximation) ───────────────
// 1 EUR ≈ 655.957 XOF (fixed parity CFA / EUR)
const XOF_TO_EUR = 655.957;
const XOF_TO_USD = 609.0; // approximate — update via exchange API

const convertToStripeCents = (amountXof, targetCurrency = 'eur') => {
  const rate = targetCurrency.toLowerCase() === 'eur' ? XOF_TO_EUR : XOF_TO_USD;
  const converted = Math.round((amountXof / rate) * 100); // cents
  return converted;
};

// ─── Create Payment Intent ────────────────────────────────

/**
 * Create a Stripe PaymentIntent for mobile/web SDK usage.
 * Returns client_secret for the frontend.
 *
 * @param {object} opts
 * @param {number}  opts.amountXof     - Amount in XOF
 * @param {string}  opts.clientEmail
 * @param {string}  opts.clientName
 * @param {string}  opts.description
 * @param {string}  opts.paymentId     - Internal payment UUID
 * @param {string}  opts.terrainRef
 * @param {string}  [opts.currency]    - 'eur' | 'usd'
 */
const createPaymentIntent = async ({
  amountXof, clientEmail, clientName, description,
  paymentId, terrainRef, currency,
}) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');

  const targetCurrency = (currency || config.stripe.currency || 'eur').toLowerCase();
  const amountCents = convertToStripeCents(amountXof, targetCurrency);

  const intent = await stripe.paymentIntents.create({
    amount:   amountCents,
    currency: targetCurrency,
    description: description || `Ikadou — Terrain ${terrainRef}`,
    receipt_email: clientEmail,
    metadata: {
      payment_id:   paymentId,
      terrain_ref:  terrainRef || '',
      client_email: clientEmail || '',
      amount_xof:   String(amountXof),
    },
    automatic_payment_methods: { enabled: true },
  });

  logger.info(`[Stripe] PaymentIntent created: ${intent.id} — ${amountCents} ${targetCurrency} (${amountXof} XOF)`);

  return {
    clientSecret:    intent.client_secret,
    paymentIntentId: intent.id,
    amountCents,
    currency:        targetCurrency,
    amountXof,
  };
};

// ─── Create Checkout Session (hosted page) ───────────────

/**
 * Create a Stripe Checkout Session (redirect-based flow).
 * Best for web — user is redirected to Stripe's hosted page.
 *
 * @param {object} opts
 * @param {number}  opts.amountXof
 * @param {string}  opts.clientEmail
 * @param {string}  opts.clientName
 * @param {string}  opts.description
 * @param {string}  opts.paymentId
 * @param {string}  opts.terrainTitle
 * @param {string}  opts.terrainRef
 * @param {string}  [opts.currency]
 */
const createCheckoutSession = async ({
  amountXof, clientEmail, clientName, description,
  paymentId, terrainTitle, terrainRef, currency,
}) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');

  const targetCurrency = (currency || config.stripe.currency || 'eur').toLowerCase();
  const amountCents = convertToStripeCents(amountXof, targetCurrency);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: clientEmail,
    line_items: [{
      price_data: {
        currency:     targetCurrency,
        unit_amount:  amountCents,
        product_data: {
          name:        terrainTitle || `Terrain ${terrainRef}`,
          description: description || 'Acquisition terrain Ikadou',
          images:      ['https://ikadou.com/assets/terrain-placeholder.jpg'],
        },
      },
      quantity: 1,
    }],
    success_url: `${config.payment.successUrl}?payment_id=${paymentId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${config.payment.cancelUrl}?payment_id=${paymentId}`,
    metadata: {
      payment_id:  paymentId,
      terrain_ref: terrainRef || '',
      amount_xof:  String(amountXof),
    },
    expires_at: Math.floor(Date.now() / 1000) + 60 * 30, // 30 min
  });

  logger.info(`[Stripe] Checkout Session: ${session.id} — ${amountCents} ${targetCurrency}`);

  return {
    sessionId:   session.id,
    checkoutUrl: session.url,
    amountCents,
    currency:    targetCurrency,
    amountXof,
    expiresAt:   new Date(session.expires_at * 1000),
  };
};

// ─── Retrieve Payment Intent ─────────────────────────────

const retrievePaymentIntent = async (paymentIntentId) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');
  return stripe.paymentIntents.retrieve(paymentIntentId);
};

// ─── Retrieve Checkout Session ───────────────────────────

const retrieveCheckoutSession = async (sessionId) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
};

// ─── Create Refund ───────────────────────────────────────

/**
 * @param {string} paymentIntentId - Stripe PaymentIntent ID
 * @param {number} [amountCents]   - Partial refund amount in cents (omit for full)
 * @param {string} [reason]        - 'duplicate' | 'fraudulent' | 'requested_by_customer'
 */
const createRefund = async (paymentIntentId, amountCents, reason = 'requested_by_customer') => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents && { amount: amountCents }),
    reason,
  });

  logger.info(`[Stripe] Refund created: ${refund.id} — status: ${refund.status}`);
  return refund;
};

// ─── Webhook signature verification ─────────────────────

/**
 * Verify Stripe webhook signature and return the event.
 * @param {Buffer} rawBody  - Express raw body (must be raw, not parsed JSON)
 * @param {string} signature - req.headers['stripe-signature']
 */
const constructWebhookEvent = (rawBody, signature) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
};

// ─── Map Stripe status to internal status ────────────────

const mapStripeStatus = (stripeStatus) => {
  const map = {
    requires_payment_method: 'pending',
    requires_confirmation:   'pending',
    requires_action:         'pending',
    processing:              'pending',
    requires_capture:        'pending',
    succeeded:               'confirmed',
    canceled:                'cancelled',
  };
  return map[stripeStatus] || 'pending';
};

module.exports = {
  createPaymentIntent,
  createCheckoutSession,
  retrievePaymentIntent,
  retrieveCheckoutSession,
  createRefund,
  constructWebhookEvent,
  mapStripeStatus,
  convertToStripeCents,
};