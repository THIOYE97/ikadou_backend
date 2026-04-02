const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query, transaction } = require('../data/db');
const stripeService  = require('../services/stripeService');
const danaPayService = require('../services/danaPayService');
const notifService   = require('../services/notificationService');
const logger         = require('../utils/logger');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error('Validation failed');
    err.type = 'validation'; err.errors = errors.array();
    return next(err);
  }
  next();
};

const STATUS_TRANSITIONS = {
  pending:   ['confirmed', 'failed', 'cancelled'],
  confirmed: ['refunded'],
  failed:    ['pending'],
  partial:   ['confirmed', 'failed', 'cancelled'],
  refunded:  [],
  cancelled: [],
};

router.use(requireAuth);

// ─── GET /payments ────────────────────────────────────────

router.get('/', requireMinRole('finance'), async (req, res, next) => {
  try {
    const { search, status, from_date, to_date, client_id, provider, page = 1, limit = 20 } = req.query;
    const params = []; const conditions = [];

    if (search)    { params.push(`%${search}%`);  conditions.push(`p.ref ILIKE $${params.length}`); }
    if (status)    { params.push(status);          conditions.push(`p.status = $${params.length}`); }
    if (client_id) { params.push(client_id);       conditions.push(`p.client_id = $${params.length}`); }
    if (provider)  { params.push(provider);        conditions.push(`p.provider = $${params.length}`); }
    if (from_date) { params.push(from_date);       conditions.push(`p.created_at >= $${params.length}`); }
    if (to_date)   { params.push(to_date);         conditions.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM payments p ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         p.id, p.ref, p.amount, p.currency, p.status, p.provider,
         p.method_type, p.provider_ref, p.checkout_url,
         p.installment_total, p.installment_num,
         p.payment_method, p.created_at, p.updated_at,
         c.first_name || ' ' || c.last_name AS client_name, p.client_id,
         t.title AS terrain_title, t.ref AS terrain_ref, p.terrain_id
       FROM payments p
       LEFT JOIN clients c  ON p.client_id = c.id
       LEFT JOIN terrains t ON p.terrain_id = t.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true, data: rows.rows,
      meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

// ─── POST /payments/stripe/intent ────────────────────────

router.post(
  '/stripe/intent',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric(),
    body('currency').optional().isIn(['eur','usd']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, currency, notes } = req.body;

      // Load client + terrain
      const [clientRes, terrainRes] = await Promise.all([
        query(`SELECT id, first_name, last_name, email FROM clients WHERE id = $1`, [clientId]),
        query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
      ]);
      if (!clientRes.rows.length) throw HttpError.notFound('Client introuvable');
      if (!terrainRes.rows.length) throw HttpError.notFound('Terrain introuvable');

      const client  = clientRes.rows[0];
      const terrain = terrainRes.rows[0];

      // Create internal payment record first
      const paymentRes = await query(
        `INSERT INTO payments
           (client_id, terrain_id, amount, currency, status, provider, method_type, notes, created_by)
         VALUES ($1,$2,$3,'XOF','pending','stripe','card',$4,$5)
         RETURNING *`,
        [clientId, terrainId, amountXof, notes || null, req.user.id]
      );
      const payment = paymentRes.rows[0];

      // Create Stripe PaymentIntent
      const intent = await stripeService.createPaymentIntent({
        amountXof,
        clientEmail: client.email,
        clientName:  `${client.first_name} ${client.last_name}`,
        description: `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:   payment.id,
        terrainRef:  terrain.ref,
        currency:    currency || 'eur',
      });

      // Update payment with Stripe ref
      await query(
        `UPDATE payments SET provider_ref = $1, provider_status = 'requires_payment_method',
         metadata = $2 WHERE id = $3`,
        [intent.paymentIntentId, JSON.stringify({ amount_eur_cents: intent.amountCents }), payment.id]
      );

      await query(
        `INSERT INTO payment_history (payment_id, action, new_status, comment, user_id)
         VALUES ($1, 'stripe_intent_created', 'pending', $2, $3)`,
        [payment.id, `Intent: ${intent.paymentIntentId}`, req.user.id]
      );

      return res.status(201).json({
        success: true,
        data: {
          paymentId:       payment.id,
          paymentRef:      payment.ref,
          clientSecret:    intent.clientSecret,
          paymentIntentId: intent.paymentIntentId,
          amountCents:     intent.amountCents,
          currency:        intent.currency,
          amountXof,
        },
      });
    } catch (error) { next(error); }
  }
);

// ─── POST /payments/stripe/checkout ──────────────────────

router.post(
  '/stripe/checkout',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, currency, notes } = req.body;

      const [clientRes, terrainRes] = await Promise.all([
        query(`SELECT id, first_name, last_name, email FROM clients WHERE id = $1`, [clientId]),
        query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
      ]);
      if (!clientRes.rows.length) throw HttpError.notFound('Client introuvable');
      if (!terrainRes.rows.length) throw HttpError.notFound('Terrain introuvable');

      const client  = clientRes.rows[0];
      const terrain = terrainRes.rows[0];

      // Create internal payment
      const paymentRes = await query(
        `INSERT INTO payments
           (client_id, terrain_id, amount, currency, status, provider, method_type, notes, created_by)
         VALUES ($1,$2,$3,'XOF','pending','stripe','card',$4,$5)
         RETURNING *`,
        [clientId, terrainId, amountXof, notes || null, req.user.id]
      );
      const payment = paymentRes.rows[0];

      // Create Stripe Checkout Session
      const session = await stripeService.createCheckoutSession({
        amountXof,
        clientEmail:  client.email,
        clientName:   `${client.first_name} ${client.last_name}`,
        description:  `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:    payment.id,
        terrainTitle: terrain.title,
        terrainRef:   terrain.ref,
        currency:     currency || 'eur',
      });

      // Update payment with session info
      await query(
        `UPDATE payments SET provider_ref = $1, checkout_url = $2,
         expires_at = $3, metadata = $4 WHERE id = $5`,
        [
          session.sessionId,
          session.checkoutUrl,
          session.expiresAt,
          JSON.stringify({ session_id: session.sessionId, amount_eur_cents: session.amountCents }),
          payment.id,
        ]
      );

      await query(
        `INSERT INTO payment_history (payment_id, action, new_status, comment, user_id)
         VALUES ($1, 'stripe_checkout_created', 'pending', $2, $3)`,
        [payment.id, `Session: ${session.sessionId}`, req.user.id]
      );

      return res.status(201).json({
        success: true,
        data: {
          paymentId:    payment.id,
          paymentRef:   payment.ref,
          checkoutUrl:  session.checkoutUrl,
          sessionId:    session.sessionId,
          amountCents:  session.amountCents,
          currency:     session.currency,
          amountXof,
          expiresAt:    session.expiresAt,
        },
      });
    } catch (error) { next(error); }
  }
);

// ─── POST /payments/danapay/transfer ─────────────────────

router.post(
  '/danapay/transfer',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric(),
    body('phone').notEmpty(),
    body('operator').isIn(['orange_money','wave','free_money','moov_money','mtn_momo']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, phone, operator, notes } = req.body;

      const [clientRes, terrainRes] = await Promise.all([
        query(`SELECT id, first_name, last_name, email, phone FROM clients WHERE id = $1`, [clientId]),
        query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
      ]);
      if (!clientRes.rows.length) throw HttpError.notFound('Client introuvable');
      if (!terrainRes.rows.length) throw HttpError.notFound('Terrain introuvable');

      const client  = clientRes.rows[0];
      const terrain = terrainRes.rows[0];

      // Create internal payment
      const paymentRes = await query(
        `INSERT INTO payments
           (client_id, terrain_id, amount, currency, status, provider, method_type, payment_method, notes, created_by)
         VALUES ($1,$2,$3,'XOF','pending','danapay',$4,$5,$6,$7)
         RETURNING *`,
        [clientId, terrainId, amountXof, operator, operator, notes || null, req.user.id]
      );
      const payment = paymentRes.rows[0];

      // Initiate DanaPay transfer
      const transfer = await danaPayService.createTransfer({
        amount:      amountXof,
        phone:       phone || client.phone,
        operator,
        description: `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:   payment.id,
        clientName:  `${client.first_name} ${client.last_name}`,
      });

      // Update payment
      await query(
        `UPDATE payments SET provider_ref = $1, provider_status = $2,
         checkout_url = $3, metadata = $4 WHERE id = $5`,
        [
          transfer.transferId,
          transfer.status,
          transfer.checkoutUrl || null,
          JSON.stringify({ operator, phone: phone || client.phone, transfer_id: transfer.transferId }),
          payment.id,
        ]
      );

      await query(
        `INSERT INTO payment_history (payment_id, action, new_status, comment, user_id)
         VALUES ($1, 'danapay_transfer_initiated', 'pending', $2, $3)`,
        [payment.id, `Transfer: ${transfer.transferId} via ${operator}`, req.user.id]
      );

      return res.status(201).json({
        success: true,
        data: {
          paymentId:   payment.id,
          paymentRef:  payment.ref,
          transferId:  transfer.transferId,
          checkoutUrl: transfer.checkoutUrl,
          status:      transfer.status,
          operator,
          amountXof,
          message: `Demande de paiement envoyée sur le ${operator} — le client doit valider sur son téléphone`,
        },
      });
    } catch (error) { next(error); }
  }
);

// ─── POST /payments/danapay/link ──────────────────────────

router.post(
  '/danapay/link',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, notes } = req.body;

      const [clientRes, terrainRes] = await Promise.all([
        query(`SELECT id, first_name, last_name, email FROM clients WHERE id = $1`, [clientId]),
        query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
      ]);
      if (!clientRes.rows.length) throw HttpError.notFound('Client introuvable');
      if (!terrainRes.rows.length) throw HttpError.notFound('Terrain introuvable');

      const client  = clientRes.rows[0];
      const terrain = terrainRes.rows[0];

      const paymentRes = await query(
        `INSERT INTO payments
           (client_id, terrain_id, amount, currency, status, provider, method_type, notes, created_by)
         VALUES ($1,$2,$3,'XOF','pending','danapay','mobile_money',$4,$5)
         RETURNING *`,
        [clientId, terrainId, amountXof, notes || null, req.user.id]
      );
      const payment = paymentRes.rows[0];

      const link = await danaPayService.createPaymentLink({
        amount:       amountXof,
        clientEmail:  client.email,
        clientName:   `${client.first_name} ${client.last_name}`,
        description:  `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:    payment.id,
        terrainTitle: terrain.title,
      });

      await query(
        `UPDATE payments SET provider_ref = $1, checkout_url = $2, expires_at = $3 WHERE id = $4`,
        [link.linkId, link.checkoutUrl, link.expiresAt, payment.id]
      );

      return res.status(201).json({
        success: true,
        data: {
          paymentId:   payment.id,
          paymentRef:  payment.ref,
          checkoutUrl: link.checkoutUrl,
          expiresAt:   link.expiresAt,
          amountXof,
        },
      });
    } catch (error) { next(error); }
  }
);

// ─── GET /payments/operators/:countryCode ─────────────────

router.get('/operators/:countryCode', (req, res) => {
  const operators = danaPayService.getOperatorsByCountry(req.params.countryCode);
  return res.json({ success: true, data: operators });
});

// ─── GET /payments/:id ────────────────────────────────────

router.get('/:id([0-9a-fA-F-]{36})', requireMinRole('finance'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*,
         c.first_name || ' ' || c.last_name AS client_name,
         c.email AS client_email, c.phone AS client_phone,
         t.title AS terrain_title, t.ref AS terrain_ref
       FROM payments p
       LEFT JOIN clients c  ON p.client_id = c.id
       LEFT JOIN terrains t ON p.terrain_id = t.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Paiement introuvable');

    const [history, docs, installments] = await Promise.all([
      query(
        `SELECT ph.*, u.first_name || ' ' || u.last_name AS author
         FROM payment_history ph
         LEFT JOIN internal_users u ON ph.user_id = u.id
         WHERE ph.payment_id = $1 ORDER BY ph.created_at DESC`,
        [req.params.id]
      ),
      query(`SELECT id, name, type, url, created_at FROM documents WHERE related_type = 'payment' AND related_id = $1`, [req.params.id]),
      query(`SELECT * FROM payment_installments WHERE payment_id = $1 ORDER BY installment_num`, [req.params.id]),
    ]);

    return res.json({
      success: true,
      data: { ...result.rows[0], history: history.rows, documents: docs.rows, installments: installments.rows },
    });
  } catch (error) { next(error); }
});

// ─── POST /payments/:id/sync ──────────────────────────────
// Re-fetch status from provider and sync

router.post('/:id([0-9a-fA-F-]{36})/sync', requireMinRole('finance'), async (req, res, next) => {
  try {
    const paymentRes = await query(
      `SELECT * FROM payments WHERE id = $1`, [req.params.id]
    );
    if (!paymentRes.rows.length) throw HttpError.notFound('Paiement introuvable');

    const payment = paymentRes.rows[0];
    let newStatus = payment.status;
    let providerStatus = payment.provider_status;

    if (payment.provider === 'stripe' && payment.provider_ref) {
      const intent = await stripeService.retrievePaymentIntent(payment.provider_ref);
      providerStatus = intent.status;
      newStatus = stripeService.mapStripeStatus(intent.status);
    } else if (payment.provider === 'danapay' && payment.provider_ref) {
      const transfer = await danaPayService.retrieveTransfer(payment.provider_ref);
      providerStatus = transfer.status;
      newStatus = danaPayService.mapDanaPayStatus(transfer.status);
    } else {
      return res.json({ success: true, message: 'Sync non applicable pour ce provider', data: payment });
    }

    if (newStatus !== payment.status) {
      await transaction(async (client) => {
        await client.query(
          `UPDATE payments SET status = $1, provider_status = $2 WHERE id = $3`,
          [newStatus, providerStatus, payment.id]
        );
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
           VALUES ($1, 'provider_sync', $2, $3, $4, $5)`,
          [payment.id, payment.status, newStatus, `Provider status: ${providerStatus}`, req.user.id]
        );
      });

      // Send notification on status change
      if (newStatus === 'confirmed') {
        await notifService.sendPaymentSuccessNotification(payment.id);
      } else if (newStatus === 'failed') {
        await notifService.sendPaymentFailureNotification(payment.id);
      }
    }

    return res.json({ success: true, message: 'Sync terminée', data: { ...payment, status: newStatus, provider_status: providerStatus } });
  } catch (error) { next(error); }
});

module.exports = router;
