const express = require('express');
const { body, query: qv, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError  = require('../utils/httpError');
const { query, transaction } = require('../data/db');
const stripe     = require('../services/stripeService');
const danaPay    = require('../services/danaPayService');
const notif      = require('../services/notificationService');
const logger     = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────

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

const loadEntities = async (clientId, terrainId) => {
  const [c, t] = await Promise.all([
    query(`SELECT id, first_name, last_name, email, phone FROM clients WHERE id = $1`, [clientId]),
    query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
  ]);
  if (!c.rows.length) throw HttpError.notFound('Client introuvable');
  if (!t.rows.length) throw HttpError.notFound('Terrain introuvable');
  return { client: c.rows[0], terrain: t.rows[0] };
};

const createBasePayment = async ({ clientId, terrainId, amount, provider, methodType, notes, userId }) =>
  query(
    `INSERT INTO payments
       (client_id, terrain_id, amount, currency, status, provider, method_type, notes, created_by)
     VALUES ($1,$2,$3,'XOF','pending',$4,$5,$6,$7)
     RETURNING *`,
    [clientId, terrainId, amount, provider, methodType, notes || null, userId]
  ).then(r => r.rows[0]);

const logHistory = (paymentId, action, comment, userId, oldStatus = null, newStatus = null) =>
  query(
    `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [paymentId, action, oldStatus, newStatus, comment || null, userId || null]
  );

// Standard list SELECT — used in both list and search
const PAYMENT_SELECT = `
  SELECT
    p.id, p.ref, p.amount, p.currency, p.status,
    p.provider, p.provider_ref, p.provider_status,
    p.method_type, p.payment_method,
    p.checkout_url, p.expires_at,
    p.installment_total, p.installment_num,
    p.notes, p.created_at, p.updated_at,
    c.first_name || ' ' || c.last_name AS client_name,
    c.email AS client_email, c.phone AS client_phone,
    p.client_id,
    t.title AS terrain_title, t.ref AS terrain_ref,
    p.terrain_id
  FROM payments p
  LEFT JOIN clients c  ON p.client_id = c.id
  LEFT JOIN terrains t ON p.terrain_id = t.id
`;

router.use(requireAuth);

// ═══════════════════════════════════════════════════════════
// GET /payments/stats  — global KPIs (all data, not paged)
// ─ Must be defined BEFORE /:id to avoid route collision
// ═══════════════════════════════════════════════════════════

router.get('/stats', requireMinRole('finance'), async (req, res, next) => {
  try {
    const { from_date, to_date, client_id, provider } = req.query;
    const params = []; const conds = [];

    if (client_id) { params.push(client_id); conds.push(`p.client_id = $${params.length}`); }
    if (provider)  { params.push(provider);  conds.push(`p.provider = $${params.length}`); }
    if (from_date) { params.push(from_date); conds.push(`p.created_at >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conds.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [global, byStatus, byProvider, recent] = await Promise.all([
      // Global totals
      query(`
        SELECT
          COUNT(*) AS total_count,
          COALESCE(SUM(amount), 0) AS total_amount,
          COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount,
          COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
          COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_count,
          COUNT(*) FILTER (WHERE provider = 'stripe') AS stripe_count,
          COUNT(*) FILTER (WHERE provider = 'danapay') AS danapay_count,
          COUNT(*) FILTER (WHERE provider = 'manual') AS manual_count
        FROM payments p ${where}
      `, params),

      // By status
      query(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
        FROM payments p ${where}
        GROUP BY status ORDER BY count DESC
      `, params),

      // By provider
      query(`
        SELECT provider, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total,
               COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed
        FROM payments p ${where}
        GROUP BY provider ORDER BY count DESC
      `, params),

      // Last 7 days trend
      query(`
        SELECT
          DATE_TRUNC('day', p.created_at)::date AS day,
          COUNT(*) AS count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount
        FROM payments p
        WHERE p.created_at >= NOW() - INTERVAL '7 days'
        ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
        GROUP BY day ORDER BY day ASC
      `, params),
    ]);

    return res.json({
      success: true,
      data: {
        global:     global.rows[0],
        by_status:  byStatus.rows,
        by_provider: byProvider.rows,
        trend_7d:   recent.rows,
      },
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// POST /payments/installment  — must be before /:id routes
// ═══════════════════════════════════════════════════════════

router.post('/installment',
  requireMinRole('finance'),
  [
    body('clientId').isUUID().withMessage('Client invalide'),
    body('terrainId').isUUID().withMessage('Terrain invalide'),
    body('totalAmountXof').isNumeric().withMessage('Montant total requis'),
    body('installments').isArray({ min: 2, max: 24 }).withMessage('Minimum 2 échéances, maximum 24'),
    body('installments.*.amountXof').isNumeric().withMessage('Montant par échéance invalide'),
    body('installments.*.dueDate').isDate().withMessage('Date d\'échéance invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, totalAmountXof, installments, notes, provider = 'manual' } = req.body;

      // Validate sum equals total (tolerance 1 XOF)
      const sum = installments.reduce((s, i) => s + Number(i.amountXof), 0);
      if (Math.abs(sum - Number(totalAmountXof)) > 1) {
        throw HttpError.badRequest(
          `La somme des échéances (${Math.round(sum)} XOF) ne correspond pas au montant total (${Number(totalAmountXof)} XOF)`
        );
      }

      // Validate dates are in the future and ascending
      const dates = installments.map(i => new Date(i.dueDate));
      for (let i = 1; i < dates.length; i++) {
        if (dates[i] <= dates[i - 1]) {
          throw HttpError.badRequest(`Les dates d'échéances doivent être croissantes`);
        }
      }

      const payment = await createBasePayment({
        clientId, terrainId,
        amount: totalAmountXof,
        provider,
        methodType: 'other',
        notes,
        userId: req.user.id,
      });

      // Update installment metadata
      await query(
        `UPDATE payments SET installment_total = $1, installment_num = 1 WHERE id = $2`,
        [installments.length, payment.id]
      );

      // Create each installment record
      for (let i = 0; i < installments.length; i++) {
        const inst = installments[i];
        await query(
          `INSERT INTO payment_installments
             (payment_id, installment_num, amount, currency, due_date)
           VALUES ($1,$2,$3,'XOF',$4)`,
          [payment.id, i + 1, Math.round(Number(inst.amountXof)), inst.dueDate]
        );
      }

      await logHistory(payment.id, 'installment_plan_created',
        `${installments.length} échéances — ${Math.round(totalAmountXof)} XOF`, req.user.id);

      return res.status(201).json({
        success: true,
        data: {
          paymentId:      payment.id,
          paymentRef:     payment.ref,
          totalAmount:    Number(totalAmountXof),
          nbInstallments: installments.length,
          firstDueDate:   installments[0].dueDate,
          lastDueDate:    installments[installments.length - 1].dueDate,
          message:        `Plan de paiement créé — ${installments.length} échéances`,
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// GET /payments/operators/:countryCode  — before /:id
// ═══════════════════════════════════════════════════════════

router.get('/operators/:countryCode', (req, res) => {
  const operators = danaPay.getOperatorsByCountry(req.params.countryCode);
  return res.json({ success: true, data: operators });
});

// ═══════════════════════════════════════════════════════════
// LIST  GET /payments
// ═══════════════════════════════════════════════════════════

router.get('/', requireMinRole('finance'), async (req, res, next) => {
  try {
    const {
      search, status, from_date, to_date,
      client_id, provider, page = 1, limit = 20,
      sort = 'created_at', order = 'desc',
    } = req.query;

    const params = []; const conds = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      // Search: ref, provider_ref, client name, terrain ref
      conds.push(`(
        p.ref ILIKE $${n}
        OR p.provider_ref ILIKE $${n}
        OR (c.first_name || ' ' || c.last_name) ILIKE $${n}
        OR t.ref ILIKE $${n}
        OR t.title ILIKE $${n}
      )`);
    }
    if (status)    { params.push(status);    conds.push(`p.status = $${params.length}`); }
    if (client_id) { params.push(client_id); conds.push(`p.client_id = $${params.length}`); }
    if (provider)  { params.push(provider);  conds.push(`p.provider = $${params.length}`); }
    if (from_date) { params.push(from_date); conds.push(`p.created_at >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conds.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

    const where  = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    // Need JOINs for the count too (search on client/terrain)
    const countSql = `
      SELECT COUNT(*) FROM payments p
      LEFT JOIN clients c  ON p.client_id = c.id
      LEFT JOIN terrains t ON p.terrain_id = t.id
      ${where}
    `;
    const total = parseInt((await query(countSql, params)).rows[0].count, 10);

    const allowedSort  = ['created_at', 'amount', 'status', 'updated_at', 'ref'];
    const sortCol      = allowedSort.includes(sort) ? `p.${sort}` : 'p.created_at';
    const sortDir      = order === 'asc' ? 'ASC' : 'DESC';

    params.push(Number(limit), offset);
    const rows = await query(
      `${PAYMENT_SELECT} ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: rows.rows,
      meta: {
        total,
        page:  +page,
        limit: +limit,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// STRIPE — Payment Intent  POST /payments/stripe/intent
// ═══════════════════════════════════════════════════════════

router.post('/stripe/intent',
  [
    body('clientId').isUUID().withMessage('Client invalide'),
    body('terrainId').isUUID().withMessage('Terrain invalide'),
    body('amountXof').isNumeric().isFloat({ min: 100 }).withMessage('Montant invalide (min 100 XOF)'),
    body('currency').optional().isIn(['eur','usd']).withMessage('Devise invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, currency, notes } = req.body;
      const { client, terrain } = await loadEntities(clientId, terrainId);

      const payment = await createBasePayment({
        clientId, terrainId,
        amount: amountXof, provider: 'stripe', methodType: 'card',
        notes, userId: req.user.id,
      });

      const intent = await stripe.createPaymentIntent({
        amountXof, currency: currency || 'eur',
        clientEmail: client.email,
        clientName:  `${client.first_name} ${client.last_name}`,
        description: `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:   payment.id,
        terrainRef:  terrain.ref,
      });

      await query(
        `UPDATE payments SET provider_ref = $1, provider_status = 'requires_payment_method',
         metadata = $2 WHERE id = $3`,
        [intent.paymentIntentId,
         JSON.stringify({ amount_eur_cents: intent.amountCents, currency: intent.currency }),
         payment.id]
      );

      await logHistory(payment.id, 'stripe_intent_created',
        `Intent: ${intent.paymentIntentId}`, req.user.id);

      return res.status(201).json({
        success: true,
        data: {
          paymentId:       payment.id,
          paymentRef:      payment.ref,
          clientSecret:    intent.clientSecret,
          paymentIntentId: intent.paymentIntentId,
          amountCents:     intent.amountCents,
          currency:        intent.currency,
          amountXof:       Number(amountXof),
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// STRIPE — Checkout Session  POST /payments/stripe/checkout
// ═══════════════════════════════════════════════════════════

router.post('/stripe/checkout',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 100 }),
    body('currency').optional().isIn(['eur','usd']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, currency, notes } = req.body;
      const { client, terrain } = await loadEntities(clientId, terrainId);

      const payment = await createBasePayment({
        clientId, terrainId,
        amount: amountXof, provider: 'stripe', methodType: 'card',
        notes, userId: req.user.id,
      });

      const session = await stripe.createCheckoutSession({
        amountXof, currency: currency || 'eur',
        clientEmail:  client.email,
        clientName:   `${client.first_name} ${client.last_name}`,
        description:  `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:    payment.id,
        terrainTitle: terrain.title,
        terrainRef:   terrain.ref,
      });

      await query(
        `UPDATE payments SET
           provider_ref = $1, checkout_url = $2, expires_at = $3,
           metadata = $4
         WHERE id = $5`,
        [session.sessionId, session.checkoutUrl, session.expiresAt,
         JSON.stringify({ session_id: session.sessionId, amount_eur_cents: session.amountCents }),
         payment.id]
      );

      await logHistory(payment.id, 'stripe_checkout_created',
        `Session: ${session.sessionId}`, req.user.id);

      return res.status(201).json({
        success: true,
        data: {
          paymentId:    payment.id,
          paymentRef:   payment.ref,
          checkoutUrl:  session.checkoutUrl,
          sessionId:    session.sessionId,
          amountCents:  session.amountCents,
          currency:     session.currency,
          amountXof:    Number(amountXof),
          expiresAt:    session.expiresAt,
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// DANAPAY — Mobile Money Transfer  POST /payments/danapay/transfer
// ═══════════════════════════════════════════════════════════

router.post('/danapay/transfer',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 500 }).withMessage('Montant minimum 500 XOF'),
    body('phone').notEmpty().withMessage('Numéro de téléphone requis'),
    body('operator').isIn(['orange_money','wave','free_money','moov_money','mtn_momo'])
      .withMessage('Opérateur Mobile Money invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, phone, operator, notes } = req.body;
      const { client, terrain } = await loadEntities(clientId, terrainId);

      const payment = await createBasePayment({
        clientId, terrainId,
        amount: amountXof, provider: 'danapay', methodType: operator,
        notes, userId: req.user.id,
      });

      // Update payment_method too for display
      await query(`UPDATE payments SET payment_method = $1 WHERE id = $2`, [operator, payment.id]);

      const transfer = await danaPay.createTransfer({
        amount:      amountXof,
        phone:       phone || client.phone,
        operator,
        description: `Terrain ${terrain.ref} — ${terrain.title}`,
        paymentId:   payment.id,
        clientName:  `${client.first_name} ${client.last_name}`,
      });

      await query(
        `UPDATE payments SET
           provider_ref = $1, provider_status = $2,
           checkout_url = $3,
           metadata = $4
         WHERE id = $5`,
        [transfer.transferId, transfer.status, transfer.checkoutUrl || null,
         JSON.stringify({ operator, phone: phone || client.phone }),
         payment.id]
      );

      await logHistory(payment.id, 'danapay_transfer_initiated',
        `${operator}: ${transfer.transferId}`, req.user.id);

      return res.status(201).json({
        success: true,
        data: {
          paymentId:   payment.id,
          paymentRef:  payment.ref,
          transferId:  transfer.transferId,
          status:      transfer.status,
          checkoutUrl: transfer.checkoutUrl,
          operator,
          amountXof:   Number(amountXof),
          phone:       phone || client.phone,
          message:     `Demande envoyée — le client doit valider sur son ${operator.replace('_', ' ')}`,
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// DANAPAY — Payment Link  POST /payments/danapay/link
// ═══════════════════════════════════════════════════════════

router.post('/danapay/link',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amountXof, notes } = req.body;
      const { client, terrain } = await loadEntities(clientId, terrainId);

      const payment = await createBasePayment({
        clientId, terrainId,
        amount: amountXof, provider: 'danapay', methodType: 'mobile_money',
        notes, userId: req.user.id,
      });

      const link = await danaPay.createPaymentLink({
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

      await logHistory(payment.id, 'danapay_link_created', `Link: ${link.linkId}`, req.user.id);

      return res.status(201).json({
        success: true,
        data: {
          paymentId:   payment.id,
          paymentRef:  payment.ref,
          checkoutUrl: link.checkoutUrl,
          expiresAt:   link.expiresAt,
          amountXof:   Number(amountXof),
          message:     'Lien de paiement généré — le client choisit son opérateur Mobile Money',
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// GET /payments/:id — full detail with history, installments, docs
// ═══════════════════════════════════════════════════════════

router.get('/:id', requireMinRole('finance'), async (req, res, next) => {
  try {
    const r = await query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) throw HttpError.notFound('Paiement introuvable');

    const paymentId = req.params.id;
    const [hist, docs, inst] = await Promise.all([
      query(
        `SELECT ph.*, u.first_name || ' ' || u.last_name AS author
         FROM payment_history ph
         LEFT JOIN internal_users u ON ph.user_id = u.id
         WHERE ph.payment_id = $1
         ORDER BY ph.created_at DESC`,
        [paymentId]
      ),
      query(
        `SELECT id, name, original_name, type, mime_type, size_bytes, url, created_at
         FROM documents
         WHERE related_type = 'payment' AND related_id = $1
         ORDER BY created_at DESC`,
        [paymentId]
      ),
      query(
        `SELECT id, installment_num, amount, currency, due_date, status, provider_ref, paid_at
         FROM payment_installments
         WHERE payment_id = $1
         ORDER BY installment_num ASC`,
        [paymentId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        ...r.rows[0],
        history:      hist.rows,
        documents:    docs.rows,
        installments: inst.rows,
      },
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// POST /payments/:id/sync  — re-fetch status from provider
// ═══════════════════════════════════════════════════════════

router.post('/:id/sync', requireMinRole('finance'), async (req, res, next) => {
  try {
    const pr = await query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
    if (!pr.rows.length) throw HttpError.notFound('Paiement introuvable');

    const payment = pr.rows[0];
    let newStatus      = payment.status;
    let providerStatus = payment.provider_status;

    if (payment.provider === 'stripe' && payment.provider_ref) {
      // Check if it's a session ID or intent ID
      let rawStatus;
      if (payment.provider_ref.startsWith('cs_')) {
        const session = await stripe.retrieveCheckoutSession(payment.provider_ref);
        rawStatus     = session.payment_intent?.status || session.status;
        providerStatus = rawStatus;
        newStatus      = stripe.mapStripeStatus(rawStatus);
        // Update provider_ref to PaymentIntent ID if available
        if (session.payment_intent?.id && session.payment_intent.id !== payment.provider_ref) {
          await query(`UPDATE payments SET provider_ref = $1 WHERE id = $2`,
            [session.payment_intent.id, payment.id]);
        }
      } else {
        const intent = await stripe.retrievePaymentIntent(payment.provider_ref);
        providerStatus = intent.status;
        newStatus      = stripe.mapStripeStatus(intent.status);
      }
    } else if (payment.provider === 'danapay' && payment.provider_ref) {
      const transfer = await danaPay.retrieveTransfer(payment.provider_ref);
      providerStatus  = transfer.status;
      newStatus       = danaPay.mapDanaPayStatus(transfer.status);
    } else {
      return res.json({ success: true, message: 'Sync non applicable pour ce provider', data: payment, synced: false });
    }

    const changed = newStatus !== payment.status;

    if (changed) {
      await transaction(async (client) => {
        await client.query(
          `UPDATE payments SET status = $1, provider_status = $2 WHERE id = $3`,
          [newStatus, providerStatus, payment.id]
        );
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment)
           VALUES ($1, 'provider_sync', $2, $3, $4)`,
          [payment.id, payment.status, newStatus, `Sync: ${providerStatus}`]
        );
      });

      // Auto-notify on confirmation
      if (newStatus === 'confirmed') {
        const [clientRes, terrainRes] = await Promise.all([
          query(`SELECT * FROM clients WHERE id = $1`, [payment.client_id]),
          query(`SELECT title FROM terrains WHERE id = $1`, [payment.terrain_id]),
        ]);
        if (clientRes.rows.length) {
          notif.notifyPaymentConfirmed({
            client:  clientRes.rows[0],
            payment: { ...payment, status: 'confirmed' },
            terrain: terrainRes.rows[0] || {},
            sentBy:  req.user.id,
          }).catch(err => logger.warn(`[Payment] Notif failed: ${err.message}`));
        }
      }
    }

    const updated = await query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [payment.id]
    );

    return res.json({
      success: true,
      data:    updated.rows[0],
      synced:  changed,
      message: changed ? `Statut mis à jour : ${payment.status} → ${newStatus}` : 'Déjà à jour',
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// POST /payments/:id/refund
// ═══════════════════════════════════════════════════════════

router.post('/:id/refund',
  requireRole('admin', 'super_admin', 'manager'),
  [
    body('reason').optional().trim().notEmpty(),
    body('amountXof').optional().isNumeric().isFloat({ min: 1 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { reason, amountXof } = req.body;

      const pr = await query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
      if (!pr.rows.length) throw HttpError.notFound('Paiement introuvable');

      const payment = pr.rows[0];

      if (payment.status !== 'confirmed') {
        throw HttpError.badRequest('Seuls les paiements confirmés peuvent être remboursés');
      }
      if (!payment.provider_ref) {
        throw HttpError.badRequest('Aucune référence provider pour ce paiement — remboursement manuel requis');
      }

      let refundResult;

      if (payment.provider === 'stripe') {
        const cents = amountXof ? stripe.convertToStripeCents(amountXof) : undefined;
        refundResult = await stripe.createRefund(
          payment.provider_ref, cents, 'requested_by_customer'
        );
      } else if (payment.provider === 'danapay') {
        refundResult = await danaPay.createRefund(
          payment.provider_ref, amountXof || undefined, reason
        );
      } else {
        throw HttpError.badRequest(
          `Remboursement automatique non supporté pour le provider "${payment.provider}". Effectuez le remboursement manuellement et changez le statut.`
        );
      }

      await transaction(async (client) => {
        await client.query(
          `UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment.id]
        );
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
           VALUES ($1, 'refunded', 'confirmed', 'refunded', $2, $3)`,
          [payment.id, reason || 'Remboursement', req.user.id]
        );
      });

      return res.json({
        success: true,
        data: {
          refund:    refundResult,
          paymentId: payment.id,
          message:   `Remboursement de ${amountXof ? amountXof + ' XOF' : 'la totalité'} initié avec succès`,
        },
      });
    } catch (e) { next(e); }
  }
);

// ═══════════════════════════════════════════════════════════
// PATCH /payments/:id/status  — manual override
// ═══════════════════════════════════════════════════════════

router.patch('/:id/status',
  requireMinRole('finance'),
  [
    body('status').isIn(['pending','confirmed','failed','refunded','partial','cancelled'])
      .withMessage('Statut invalide'),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;

      const pr = await query(`SELECT status FROM payments WHERE id = $1`, [req.params.id]);
      if (!pr.rows.length) throw HttpError.notFound('Paiement introuvable');

      const oldStatus = pr.rows[0].status;
      const allowed   = STATUS_TRANSITIONS[oldStatus] || [];

      if (!allowed.includes(status)) {
        throw HttpError.badRequest(
          `Transition "${oldStatus}" → "${status}" non autorisée.` +
          (allowed.length ? ` Autorisées : ${allowed.join(', ')}` : ' Aucune transition possible.')
        );
      }

      // Sensitive transitions require manager+
      if (['confirmed','refunded'].includes(status)) {
        const roleLevel = { super_admin:7, admin:6, manager:5, finance:4, sales:3, support:3, agent:2 };
        if ((roleLevel[req.user.role] || 0) < 5) {
          throw HttpError.forbidden(`Le rôle "${req.user.role}" ne peut pas effectuer cette transition`);
        }
      }

      await transaction(async (client) => {
        await client.query(`UPDATE payments SET status = $1 WHERE id = $2`, [status, req.params.id]);
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
           VALUES ($1, 'manual_override', $2, $3, $4, $5)`,
          [req.params.id, oldStatus, status, comment || null, req.user.id]
        );
      });

      // Notify on manual confirmation
      if (status === 'confirmed') {
        const payment = await query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
        const [clientRes, terrainRes] = await Promise.all([
          query(`SELECT * FROM clients WHERE id = $1`, [payment.rows[0].client_id]),
          query(`SELECT title FROM terrains WHERE id = $1`, [payment.rows[0].terrain_id]),
        ]);
        if (clientRes.rows.length) {
          notif.notifyPaymentConfirmed({
            client:  clientRes.rows[0],
            payment: { ...payment.rows[0], status: 'confirmed' },
            terrain: terrainRes.rows[0] || {},
            sentBy:  req.user.id,
          }).catch(err => logger.warn(`[Payment] Notif failed: ${err.message}`));
        }
      }

      const updated = await query(
        `${PAYMENT_SELECT} WHERE p.id = $1`,
        [req.params.id]
      );

      return res.json({ success: true, data: updated.rows[0] });
    } catch (e) { next(e); }
  }
);

module.exports = router;
