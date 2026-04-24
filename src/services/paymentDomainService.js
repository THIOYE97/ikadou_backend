const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const stripe = require('./stripeService');
const danaPay = require('./danaPayService');
const notif = require('./notificationService');
const logger = require('../utils/logger');

const STATUS_TRANSITIONS = {
  pending: ['confirmed', 'failed', 'cancelled'],
  confirmed: ['refunded'],
  failed: ['pending'],
  partial: ['confirmed', 'failed', 'cancelled'],
  refunded: [],
  cancelled: [],
};

const PAYMENT_SELECT = `
  SELECT
    p.id, p.ref, p.amount, p.currency, p.status,
    p.provider, p.provider_ref, p.provider_status,
    p.method_type, p.payment_method, p.payment_purpose,
    p.checkout_url, p.expires_at,
    p.installment_total, p.installment_num,
    p.notes, p.created_at, p.updated_at,
    p.reference_code, p.client_instruction_note, p.proof_status,
    p.project_id,
    c.first_name || ' ' || c.last_name AS client_name,
    c.email AS client_email, c.phone AS client_phone,
    p.client_id,
    t.title AS terrain_title, t.ref AS terrain_ref,
    p.terrain_id
  FROM payments p
  LEFT JOIN clients c ON p.client_id = c.id
  LEFT JOIN terrains t ON p.terrain_id = t.id
`;
async function loadEntities(clientId, terrainId) {
  const [c, t] = await Promise.all([
    query(`SELECT id, first_name, last_name, email, phone, push_token FROM clients WHERE id = $1`, [clientId]),
    query(`SELECT id, ref, title FROM terrains WHERE id = $1`, [terrainId]),
  ]);

  if (!c.rows.length) throw HttpError.notFound('Client introuvable');
  if (!t.rows.length) throw HttpError.notFound('Terrain introuvable');

  return { client: c.rows[0], terrain: t.rows[0] };
}

function notifyPaymentSafely(fn, payload, label = 'payment') {
  Promise.resolve()
    .then(() => fn(payload))
    .catch((err) => logger.warn(`[Payment] Notification ${label} failed: ${err.message}`));
}

async function createBasePayment({ clientId, terrainId, amount, provider, methodType, notes, userId }) {
  const result = await query(
    `INSERT INTO payments
       (client_id, terrain_id, amount, currency, status, provider, method_type, notes, created_by)
     VALUES ($1,$2,$3,'XOF','pending',$4,$5,$6,$7)
     RETURNING *`,
    [clientId, terrainId, amount, provider, methodType, notes || null, userId]
  );

  return result.rows[0];
}
function phoneLooksMalian(phone) {
  const normalized = String(phone || '').replace(/\s/g, '');
  return normalized.startsWith('+223') || normalized.startsWith('00223');
}

function buildRecommendedMethod(client) {
  if (phoneLooksMalian(client?.phone)) return 'mobile_money';
  return 'bank_transfer';
}

async function getClientProjectOrThrow(projectId, clientId) {
  const result = await query(
    `
      SELECT id, client_id, terrain_id, status, steps, current_step
      FROM client_projects
      WHERE id = $1 AND client_id = $2
      LIMIT 1
    `,
    [projectId, clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Projet introuvable');
  }

  return result.rows[0];
}

async function listPaymentMethodConfigs({ activeOnly = true } = {}) {
  const params = [];
  const where = [];

  if (activeOnly) {
    where.push(`is_active = TRUE`);
  }

  const result = await query(
    `
      SELECT
        id,
        code,
        label,
        description,
        is_active,
        priority,
        country_code,
        currency,
        instructions_json,
        rules_json,
        created_at,
        updated_at
      FROM payment_method_configs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority ASC, label ASC
    `,
    params
  );

  return result.rows;
}

function normalizePaymentMethodConfig(row) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    isActive: row.is_active,
    priority: row.priority,
    countryCode: row.country_code,
    currency: row.currency,
    instructions: row.instructions_json || {},
    rules: row.rules_json || {},
  };
}

async function getClientPaymentOptions({ clientId, terrainId = null, projectId = null }) {
  const [client] = (await query(
    `SELECT id, first_name, last_name, email, phone FROM clients WHERE id = $1 LIMIT 1`,
    [clientId]
  )).rows;

  if (!client) throw HttpError.notFound('Client introuvable');

  if (terrainId) {
    const terrain = await query(`SELECT id FROM terrains WHERE id = $1 LIMIT 1`, [terrainId]);
    if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');
  }

  if (projectId) {
    await getClientProjectOrThrow(projectId, clientId);
  }

  const methods = (await listPaymentMethodConfigs({ activeOnly: true })).map(normalizePaymentMethodConfig);

  return {
    recommendedMethod: buildRecommendedMethod(client),
    methods,
  };
}

function buildClientInstructionNote({ method }) {
  if (method.code === 'mobile_money') {
    return 'Choisissez un compte Mobile Money ci-dessous, effectuez le paiement, puis envoyez votre preuve.';
  }

  if (method.code === 'bank_transfer') {
    return 'Effectuez le virement vers un compte Ikadou puis transmettez votre preuve de paiement.';
  }

  if (method.code === 'cash') {
    return 'Présentez-vous dans un point de paiement Ikadou pour régler ce montant.';
  }

  return 'Suivez les instructions fournies pour finaliser votre paiement.';
}

async function createManualClientFacingPayment({
  clientId,
  terrainId,
  projectId = null,
  amount,
  reason = 'other',
  paymentMethod,
  note = null,
}) {
  const allowedPaymentMethods = ['mobile_money', 'bank_transfer', 'cash'];
  const allowedPurposes = ['reservation', 'installment', 'balance', 'other'];

  if (!allowedPaymentMethods.includes(paymentMethod)) {
    throw HttpError.badRequest('Mode de paiement invalide');
  }

  if (!allowedPurposes.includes(reason)) {
    throw HttpError.badRequest('Motif de paiement invalide');
  }

  const { client, terrain } = await loadEntities(clientId, terrainId);

  let project = null;
  if (projectId) {
    project = await getClientProjectOrThrow(projectId, clientId);

    if (project.status === 'cancelled') {
      throw HttpError.badRequest("Ce projet a été annulé, aucun paiement ne peut être créé.");
    }

    if (project.terrain_id && project.terrain_id !== terrainId) {
      throw HttpError.badRequest(
        "Le terrain du paiement ne correspond pas au terrain actuellement lié à ce projet."
      );
    }

    const visitDone = project?.steps?.visite?.status === 'completed';
    if (!visitDone && reason === 'reservation') {
      throw HttpError.badRequest(
        'La visite doit être validée avant de lancer le paiement de réservation.'
      );
    }
  }

  const methodConfigs = await listPaymentMethodConfigs({ activeOnly: true });
  const selectedMethodRow = methodConfigs.find((item) => item.code === paymentMethod);

  if (!selectedMethodRow) {
    throw HttpError.badRequest("Ce mode de paiement n'est pas disponible pour le moment.");
  }

  const selectedMethod = normalizePaymentMethodConfig(selectedMethodRow);

  const result = await transaction(async (db) => {
    const paymentRes = await db(
      `
        INSERT INTO payments (
          client_id,
          terrain_id,
          project_id,
          amount,
          currency,
          status,
          provider,
          provider_status,
          method_type,
          payment_method,
          payment_purpose,
          notes,
          client_instruction_note,
          proof_status
        )
        VALUES (
          $1, $2, $3, $4, 'XOF', 'pending',
          'manual', 'pending',
          $5, $6, $7, $8, $9, 'none'
        )
        RETURNING *
      `,
      [
        clientId,
        terrainId,
        projectId || null,
        Math.round(Number(amount)),
        paymentMethod,
        paymentMethod,
        reason,
        note || null,
        buildClientInstructionNote({ method: selectedMethod }),
      ]
    );

    const payment = paymentRes.rows[0];

    await db(
      `
        INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
        VALUES ($1, 'client_payment_created', NULL, 'pending', $2, NULL)
      `,
      [payment.id, `Paiement créé par le client via ${paymentMethod}`]
    );

    if (projectId) {
      await db(
        `
          UPDATE client_projects
          SET
            current_step = 'achat',
            steps = jsonb_set(
              COALESCE(steps, '{}'::jsonb),
              '{achat}',
              COALESCE(steps->'achat', '{}'::jsonb) ||
              jsonb_build_object(
                'key', 'achat',
                'label', 'Achat',
                'status', 'in_progress',
                'started_at', COALESCE(steps->'achat'->>'started_at', NOW()::text),
                'payment_id', $2
              ),
              true
            ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [projectId, payment.id]
      );
    }

    return payment;
  });
  notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment: result,
    terrain,
    sentBy: null,
  },
  'created'
);
  return {
    id: result.id,
    paymentId: result.id,
    reference_code: result.reference_code || result.ref || null,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    paymentMethod,
    purpose: reason,
    terrain: {
      id: terrain.id,
      title: terrain.title,
      ref: terrain.ref,
    },
    instructions: selectedMethod.instructions,
    clientInstructionNote: result.client_instruction_note,
    message: 'Paiement créé avec succès',
  };
}
async function logHistory(paymentId, action, comment, userId, oldStatus = null, newStatus = null) {
  await query(
    `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [paymentId, action, oldStatus, newStatus, comment || null, userId || null]
  );
}

async function getPaymentOrThrow(paymentId) {
  const result = await query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
  if (!result.rows.length) throw HttpError.notFound('Paiement introuvable');
  return result.rows[0];
}

async function recomputePaymentProofStatus(paymentId, db = query) {
  const result = await db(
    `
      SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
        COUNT(*) FILTER (WHERE status = 'under_review')::int AS review_count,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted_count
      FROM payment_proofs
      WHERE payment_id = $1
    `,
    [paymentId]
  );

  const stats = result.rows[0] || {};
  const total = Number(stats.total_count || 0);

  let proofStatus = 'none';
  if (total === 0) {
    proofStatus = 'none';
  } else if (Number(stats.approved_count || 0) > 0) {
    proofStatus = 'approved';
  } else if (Number(stats.review_count || 0) > 0) {
    proofStatus = 'under_review';
  } else if (Number(stats.submitted_count || 0) > 0) {
    proofStatus = 'submitted';
  } else if (Number(stats.rejected_count || 0) === total) {
    proofStatus = 'rejected';
  } else {
    proofStatus = 'submitted';
  }

  await db(
    `
      UPDATE payments
      SET proof_status = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [paymentId, proofStatus]
  );

  return proofStatus;
}

async function listPaymentProofsForReview({ paymentId }) {
  await getPaymentOrThrow(paymentId);

  const result = await query(
    `
      SELECT
        pp.*,
        iu.first_name || ' ' || iu.last_name AS reviewed_by_name,
        COALESCE(
          (
            SELECT json_agg(ppf ORDER BY ppf.created_at ASC)
            FROM payment_proof_files ppf
            WHERE ppf.payment_proof_id = pp.id
          ),
          '[]'::json
        ) AS files
      FROM payment_proofs pp
      LEFT JOIN internal_users iu ON iu.id = pp.reviewed_by
      WHERE pp.payment_id = $1
      ORDER BY pp.submitted_at DESC
    `,
    [paymentId]
  );

  return result.rows;
}

async function reviewPaymentProof({ proofId, status, reviewNote = null, userId }) {
  const proofRes = await query(
    `
      SELECT pp.*, p.client_id, p.terrain_id
      FROM payment_proofs pp
      INNER JOIN payments p ON p.id = pp.payment_id
      WHERE pp.id = $1
      LIMIT 1
    `,
    [proofId]
  );

  if (!proofRes.rows.length) {
    throw HttpError.notFound('Preuve introuvable');
  }

  const proof = proofRes.rows[0];
  const oldStatus = proof.status;

  const allowed = ['under_review', 'approved', 'rejected'];
  if (!allowed.includes(status)) {
    throw HttpError.badRequest('Statut de review invalide');
  }

  if (status === 'rejected' && !String(reviewNote || '').trim()) {
    throw HttpError.badRequest('Le motif de rejet est requis');
  }

  await transaction(async (client) => {
    await client.query(
      `
        UPDATE payment_proofs
        SET status = $2,
            note = CASE
              WHEN $3::text IS NOT NULL AND $3::text <> '' THEN COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE E'\n\n' END || 'Review: ' || $3::text
              ELSE note
            END,
            reviewed_at = NOW(),
            reviewed_by = $4
        WHERE id = $1
      `,
      [proofId, status, reviewNote || null, userId]
    );

    await client.query(
      `
        INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
        VALUES ($1, 'proof_review', $2, $3, $4, $5)
      `,
      [
        proof.payment_id,
        oldStatus,
        status,
        reviewNote || `Preuve marquée ${status}`,
        userId,
      ]
    );

    await recomputePaymentProofStatus(proof.payment_id, (sql, params) => client.query(sql, params));

    const [clientRes, terrainRes] = await Promise.all([
  query(`SELECT * FROM clients WHERE id = $1`, [proof.client_id]),
  query(`SELECT * FROM terrains WHERE id = $1`, [proof.terrain_id]),
]);

if (clientRes.rows.length) {
  const client = clientRes.rows[0];
  const terrain = terrainRes.rows[0] || {};

  if (status === 'approved') {
    notifyPaymentSafely(
      notif.notifyPaymentProofApproved,
      {
        client,
        payment: { ...payment, proof_status: 'approved' },
        terrain,
        sentBy: userId,
      },
      'proof_approved'
    );

    notifyPaymentSafely(
      notif.notifyPaymentConfirmed,
      {
        client,
        payment: { ...payment, proof_status: 'approved' },
        terrain,
        sentBy: userId,
      },
      'payment_confirmed_after_proof'
    );
  }

  if (status === 'rejected') {
    notifyPaymentSafely(
      notif.notifyPaymentProofRejected,
      {
        client,
        payment,
        terrain,
        reason: reviewNote || 'Preuve non conforme',
        sentBy: userId,
      },
      'proof_rejected'
    );
  }
}
  });

  const updatedProofRes = await query(
    `
      SELECT
        pp.*,
        iu.first_name || ' ' || iu.last_name AS reviewed_by_name,
        COALESCE(
          (
            SELECT json_agg(ppf ORDER BY ppf.created_at ASC)
            FROM payment_proof_files ppf
            WHERE ppf.payment_proof_id = pp.id
          ),
          '[]'::json
        ) AS files
      FROM payment_proofs pp
      LEFT JOIN internal_users iu ON iu.id = pp.reviewed_by
      WHERE pp.id = $1
      LIMIT 1
    `,
    [proofId]
  );

  const paymentRes = await query(`${PAYMENT_SELECT} WHERE p.id = $1`, [proof.payment_id]);
  const payment = paymentRes.rows[0];

  if (status === 'approved') {
    const [clientRes, terrainRes] = await Promise.all([
      query(`SELECT * FROM clients WHERE id = $1`, [proof.client_id]),
      query(`SELECT * FROM terrains WHERE id = $1`, [proof.terrain_id]),
    ]);

    if (clientRes.rows.length) {
      notif.notifyPaymentConfirmed({
        client: clientRes.rows[0],
        payment: { ...payment, proof_status: 'approved' },
        terrain: terrainRes.rows[0] || {},
        sentBy: userId,
      }).catch((err) => logger.warn(`[Payment] Notif failed after proof approval: ${err.message}`));
    }
  }

  return {
    proof: updatedProofRes.rows[0],
    payment,
    message:
      status === 'approved'
        ? 'Preuve validée'
        : status === 'rejected'
        ? 'Preuve rejetée'
        : 'Preuve marquée en revue',
  };
}

async function getPaymentDetail(paymentId) {
  const r = await query(`${PAYMENT_SELECT} WHERE p.id = $1`, [paymentId]);
  if (!r.rows.length) throw HttpError.notFound('Paiement introuvable');

  const [hist, docs, inst, proofs] = await Promise.all([
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
    query(
      `
        SELECT
          pp.*,
          iu.first_name || ' ' || iu.last_name AS reviewed_by_name,
          COALESCE(
            (
              SELECT json_agg(ppf ORDER BY ppf.created_at ASC)
              FROM payment_proof_files ppf
              WHERE ppf.payment_proof_id = pp.id
            ),
            '[]'::json
          ) AS files
        FROM payment_proofs pp
        LEFT JOIN internal_users iu ON iu.id = pp.reviewed_by
        WHERE pp.payment_id = $1
        ORDER BY pp.submitted_at DESC
      `,
      [paymentId]
    ),
  ]);

  return {
    ...r.rows[0],
    history: hist.rows,
    documents: docs.rows,
    installments: inst.rows,
    proofs: proofs.rows,
    latest_proof_status: proofs.rows[0]?.status || r.rows[0].proof_status || 'none',
  };
}

async function listPayments({
  search, status, from_date, to_date,
  client_id, project_id, provider, payment_method,
  page = 1, limit = 20,
  sort = 'created_at', order = 'desc',
}) {
  const params = [];
  const conds = [];
  if (project_id) { params.push(project_id); conds.push(`p.project_id = $${params.length}`); }
if (payment_method) { params.push(payment_method); conds.push(`p.payment_method = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(
      p.ref ILIKE $${n}
      OR p.provider_ref ILIKE $${n}
      OR (c.first_name || ' ' || c.last_name) ILIKE $${n}
      OR t.ref ILIKE $${n}
      OR t.title ILIKE $${n}
    )`);
  }
  if (status) { params.push(status); conds.push(`p.status = $${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`p.client_id = $${params.length}`); }
  if (provider) { params.push(provider); conds.push(`p.provider = $${params.length}`); }
  if (from_date) { params.push(from_date); conds.push(`p.created_at >= $${params.length}`); }
  if (to_date) { params.push(to_date); conds.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const countSql = `
    SELECT COUNT(*)
    FROM payments p
    LEFT JOIN clients c ON p.client_id = c.id
    LEFT JOIN terrains t ON p.terrain_id = t.id
    ${where}
  `;
  const total = parseInt((await query(countSql, params)).rows[0].count, 10);

  const allowedSort = ['created_at', 'amount', 'status', 'updated_at', 'ref'];
  const sortCol = allowedSort.includes(sort) ? `p.${sort}` : 'p.created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  params.push(safeLimit, offset);
  const rows = await query(
    `${PAYMENT_SELECT} ${where}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: rows.rows,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
    },
  };
}

async function getPaymentStats({ from_date, to_date, client_id, provider }) {
  const params = [];
  const conds = [];

  if (client_id) { params.push(client_id); conds.push(`p.client_id = $${params.length}`); }
  if (provider) { params.push(provider); conds.push(`p.provider = $${params.length}`); }
  if (from_date) { params.push(from_date); conds.push(`p.created_at >= $${params.length}`); }
  if (to_date) { params.push(to_date); conds.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const [global, byStatus, byProvider, recent] = await Promise.all([
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
    query(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM payments p ${where}
      GROUP BY status
      ORDER BY count DESC
    `, params),
    query(`
      SELECT provider, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total,
             COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed
      FROM payments p ${where}
      GROUP BY provider
      ORDER BY count DESC
    `, params),
    query(`
      SELECT DATE_TRUNC('day', p.created_at)::date AS day,
             COUNT(*) AS count,
             COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount
      FROM payments p
      WHERE p.created_at >= NOW() - INTERVAL '7 days'
      ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
      GROUP BY day
      ORDER BY day ASC
    `, params),
  ]);

  return {
    global: global.rows[0],
    by_status: byStatus.rows,
    by_provider: byProvider.rows,
    trend_7d: recent.rows,
  };
}

async function createInstallmentPlan({ clientId, terrainId, totalAmountXof, installments, notes, provider = 'manual', userId }) {
  const sum = installments.reduce((s, i) => s + Number(i.amountXof), 0);
  if (Math.abs(sum - Number(totalAmountXof)) > 1) {
    throw HttpError.badRequest(
      `La somme des échéances (${Math.round(sum)} XOF) ne correspond pas au montant total (${Number(totalAmountXof)} XOF)`
    );
  }

  const dates = installments.map((i) => new Date(i.dueDate));
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] <= dates[i - 1]) {
      throw HttpError.badRequest(`Les dates d'échéances doivent être croissantes`);
    }
  }

  await loadEntities(clientId, terrainId);

  const payment = await createBasePayment({
    clientId,
    terrainId,
    amount: totalAmountXof,
    provider,
    methodType: 'other',
    notes,
    userId,
  });

  await transaction(async (client) => {
    await client.query(
      `UPDATE payments SET installment_total = $1, installment_num = 1 WHERE id = $2`,
      [installments.length, payment.id]
    );

    for (let i = 0; i < installments.length; i++) {
      const inst = installments[i];
      await client.query(
        `INSERT INTO payment_installments
           (payment_id, installment_num, amount, currency, due_date)
         VALUES ($1,$2,$3,'XOF',$4)`,
        [payment.id, i + 1, Math.round(Number(inst.amountXof)), inst.dueDate]
      );
    }
  });

  await logHistory(
    payment.id,
    'installment_plan_created',
    `${installments.length} échéances — ${Math.round(totalAmountXof)} XOF`,
    userId
  );

  const { client, terrain } = await loadEntities(clientId, terrainId);

notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment,
    terrain,
    sentBy: userId,
  },
  'installment_created'
);

  return {
    paymentId: payment.id,
    paymentRef: payment.ref,
    totalAmount: Number(totalAmountXof),
    nbInstallments: installments.length,
    firstDueDate: installments[0].dueDate,
    lastDueDate: installments[installments.length - 1].dueDate,
    message: `Plan de paiement créé — ${installments.length} échéances`,
  };
}

async function createStripeIntentPayment({ clientId, terrainId, amountXof, currency, notes, userId }) {
  const { client, terrain } = await loadEntities(clientId, terrainId);

  const payment = await createBasePayment({
    clientId,
    terrainId,
    amount: amountXof,
    provider: 'stripe',
    methodType: 'card',
    notes,
    userId,
  });

  const intent = await stripe.createPaymentIntent({
    amountXof,
    currency: currency || 'eur',
    clientEmail: client.email,
    clientName: `${client.first_name} ${client.last_name}`,
    description: `Terrain ${terrain.ref} — ${terrain.title}`,
    paymentId: payment.id,
    terrainRef: terrain.ref,
  });

  await query(
    `UPDATE payments
     SET provider_ref = $1,
         provider_status = 'requires_payment_method',
         metadata = $2
     WHERE id = $3`,
    [
      intent.paymentIntentId,
      JSON.stringify({ amount_eur_cents: intent.amountCents, currency: intent.currency }),
      payment.id,
    ]
  );

  await logHistory(payment.id, 'stripe_intent_created', `Intent: ${intent.paymentIntentId}`, userId);

  notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment,
    terrain,
    sentBy: userId,
  },
  'stripe_intent_created'
);

  return {
    paymentId: payment.id,
    paymentRef: payment.ref,
    clientSecret: intent.clientSecret,
    paymentIntentId: intent.paymentIntentId,
    amountCents: intent.amountCents,
    currency: intent.currency,
    amountXof: Number(amountXof),
  };
}

async function createStripeCheckoutPayment({ clientId, terrainId, amountXof, currency, notes, userId }) {
  const { client, terrain } = await loadEntities(clientId, terrainId);

  const payment = await createBasePayment({
    clientId,
    terrainId,
    amount: amountXof,
    provider: 'stripe',
    methodType: 'card',
    notes,
    userId,
  });

  const session = await stripe.createCheckoutSession({
    amountXof,
    currency: currency || 'eur',
    clientEmail: client.email,
    clientName: `${client.first_name} ${client.last_name}`,
    description: `Terrain ${terrain.ref} — ${terrain.title}`,
    paymentId: payment.id,
    terrainTitle: terrain.title,
    terrainRef: terrain.ref,
  });

  await query(
    `UPDATE payments
     SET provider_ref = $1,
         checkout_url = $2,
         expires_at = $3,
         metadata = $4
     WHERE id = $5`,
    [
      session.sessionId,
      session.checkoutUrl,
      session.expiresAt,
      JSON.stringify({ session_id: session.sessionId, amount_eur_cents: session.amountCents }),
      payment.id,
    ]
  );

  await logHistory(payment.id, 'stripe_checkout_created', `Session: ${session.sessionId}`, userId);

  notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment,
    terrain,
    sentBy: userId,
  },
  'stripe_checkout_created'
);

  return {
    paymentId: payment.id,
    paymentRef: payment.ref,
    checkoutUrl: session.checkoutUrl,
    sessionId: session.sessionId,
    amountCents: session.amountCents,
    currency: session.currency,
    amountXof: Number(amountXof),
    expiresAt: session.expiresAt,
  };
}

async function createDanaPayTransferPayment({ clientId, terrainId, amountXof, phone, operator, notes, userId }) {
  const { client, terrain } = await loadEntities(clientId, terrainId);

  const payment = await createBasePayment({
    clientId,
    terrainId,
    amount: amountXof,
    provider: 'danapay',
    methodType: operator,
    notes,
    userId,
  });

  await query(`UPDATE payments SET payment_method = $1 WHERE id = $2`, [operator, payment.id]);

  const transfer = await danaPay.createTransfer({
    amount: amountXof,
    phone: phone || client.phone,
    operator,
    description: `Terrain ${terrain.ref} — ${terrain.title}`,
    paymentId: payment.id,
    clientName: `${client.first_name} ${client.last_name}`,
  });

  await query(
    `UPDATE payments
     SET provider_ref = $1,
         provider_status = $2,
         checkout_url = $3,
         metadata = $4
     WHERE id = $5`,
    [
      transfer.transferId,
      transfer.status,
      transfer.checkoutUrl || null,
      JSON.stringify({ operator, phone: phone || client.phone }),
      payment.id,
    ]
  );

  await logHistory(payment.id, 'danapay_transfer_initiated', `${operator}: ${transfer.transferId}`, userId);

  notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment,
    terrain,
    sentBy: userId,
  },
  'danapay_transfer_created'
);

  return {
    paymentId: payment.id,
    paymentRef: payment.ref,
    transferId: transfer.transferId,
    status: transfer.status,
    checkoutUrl: transfer.checkoutUrl,
    operator,
    amountXof: Number(amountXof),
    phone: phone || client.phone,
    message: `Demande envoyée — le client doit valider sur son ${operator.replace('_', ' ')}`,
  };
}

async function createDanaPayLinkPayment({ clientId, terrainId, amountXof, notes, userId }) {
  const { client, terrain } = await loadEntities(clientId, terrainId);

  const payment = await createBasePayment({
    clientId,
    terrainId,
    amount: amountXof,
    provider: 'danapay',
    methodType: 'mobile_money',
    notes,
    userId,
  });

  const link = await danaPay.createPaymentLink({
    amount: amountXof,
    clientEmail: client.email,
    clientName: `${client.first_name} ${client.last_name}`,
    description: `Terrain ${terrain.ref} — ${terrain.title}`,
    paymentId: payment.id,
    terrainTitle: terrain.title,
  });

  await query(
    `UPDATE payments SET provider_ref = $1, checkout_url = $2, expires_at = $3 WHERE id = $4`,
    [link.linkId, link.checkoutUrl, link.expiresAt, payment.id]
  );

  await logHistory(payment.id, 'danapay_link_created', `Link: ${link.linkId}`, userId);

  notifyPaymentSafely(
  notif.notifyPaymentCreated,
  {
    client,
    payment,
    terrain,
    sentBy: userId,
  },
  'danapay_link_created'
);

  return {
    paymentId: payment.id,
    paymentRef: payment.ref,
    checkoutUrl: link.checkoutUrl,
    expiresAt: link.expiresAt,
    amountXof: Number(amountXof),
    message: 'Lien de paiement généré — le client choisit son opérateur Mobile Money',
  };
}

async function syncPaymentStatus({ paymentId, userId }) {
  const payment = await getPaymentOrThrow(paymentId);
  let newStatus = payment.status;
  let providerStatus = payment.provider_status;

  if (payment.provider === 'stripe' && payment.provider_ref) {
    if (payment.provider_ref.startsWith('cs_')) {
      const session = await stripe.retrieveCheckoutSession(payment.provider_ref);
      const rawStatus = session.payment_intent?.status || session.status;
      providerStatus = rawStatus;
      newStatus = stripe.mapStripeStatus(rawStatus);
      if (session.payment_intent?.id && session.payment_intent.id !== payment.provider_ref) {
        await query(`UPDATE payments SET provider_ref = $1 WHERE id = $2`, [session.payment_intent.id, payment.id]);
      }
    } else {
      const intent = await stripe.retrievePaymentIntent(payment.provider_ref);
      providerStatus = intent.status;
      newStatus = stripe.mapStripeStatus(intent.status);
    }
  } else if (payment.provider === 'danapay' && payment.provider_ref) {
    const transfer = await danaPay.retrieveTransfer(payment.provider_ref);
    providerStatus = transfer.status;
    newStatus = danaPay.mapDanaPayStatus(transfer.status);
  } else {
    return {
      payment,
      synced: false,
      message: 'Sync non applicable pour ce provider',
    };
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

    if (newStatus === 'confirmed') {
      const [clientRes, terrainRes] = await Promise.all([
        query(`SELECT * FROM clients WHERE id = $1`, [payment.client_id]),
        query(`SELECT * FROM terrains WHERE id = $1`, [payment.terrain_id]),
      ]);

      if (clientRes.rows.length) {
        notif.notifyPaymentConfirmed({
          client: clientRes.rows[0],
          payment: { ...payment, status: 'confirmed' },
          terrain: terrainRes.rows[0] || {},
          sentBy: userId,
        }).catch((err) => logger.warn(`[Payment] Notif failed: ${err.message}`));
      }
    }
  }

  const updated = await query(`${PAYMENT_SELECT} WHERE p.id = $1`, [payment.id]);

  return {
    payment: updated.rows[0],
    synced: changed,
    message: changed ? `Statut mis à jour : ${payment.status} → ${newStatus}` : 'Déjà à jour',
  };
}

async function refundPayment({ paymentId, reason, amountXof, userId }) {
  const payment = await getPaymentOrThrow(paymentId);

  if (payment.status !== 'confirmed') {
    throw HttpError.badRequest('Seuls les paiements confirmés peuvent être remboursés');
  }
  if (!payment.provider_ref) {
    throw HttpError.badRequest('Aucune référence provider pour ce paiement — remboursement manuel requis');
  }

  let refundResult;

  if (payment.provider === 'stripe') {
    const cents = amountXof ? stripe.convertToStripeCents(amountXof) : undefined;
    refundResult = await stripe.createRefund(payment.provider_ref, cents, 'requested_by_customer');
  } else if (payment.provider === 'danapay') {
    refundResult = await danaPay.createRefund(payment.provider_ref, amountXof || undefined, reason);
  } else {
    throw HttpError.badRequest(
      `Remboursement automatique non supporté pour le provider "${payment.provider}". Effectuez le remboursement manuellement et changez le statut.`
    );
  }

  await transaction(async (client) => {
    await client.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment.id]);
    await client.query(
      `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
       VALUES ($1, 'refunded', 'confirmed', 'refunded', $2, $3)`,
      [payment.id, reason || 'Remboursement', userId]
    );
  });

  return {
    refund: refundResult,
    paymentId: payment.id,
    message: `Remboursement de ${amountXof ? amountXof + ' XOF' : 'la totalité'} initié avec succès`,
  };
}

module.exports = {
  PAYMENT_SELECT,
  STATUS_TRANSITIONS,
  loadEntities,
  createBasePayment,
  logHistory,
  getPaymentDetail,
  listPayments,
  getPaymentStats,
  createInstallmentPlan,
  createStripeIntentPayment,
  createStripeCheckoutPayment,
  createDanaPayTransferPayment,
  createDanaPayLinkPayment,
  syncPaymentStatus,
  refundPayment,
  listPaymentMethodConfigs,
  getClientPaymentOptions,
  createManualClientFacingPayment,
};