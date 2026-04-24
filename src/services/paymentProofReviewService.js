const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const notif = require('./notificationService');
const logger = require('../utils/logger');

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
  const paymentRes = await query(
    `SELECT id FROM payments WHERE id = $1 LIMIT 1`,
    [paymentId]
  );

  if (!paymentRes.rows.length) {
    throw HttpError.notFound('Paiement introuvable');
  }

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
  const allowedStatuses = ['under_review', 'approved', 'rejected'];
  if (!allowedStatuses.includes(status)) {
    throw HttpError.badRequest('Statut de review invalide');
  }

  if (status === 'rejected' && !String(reviewNote || '').trim()) {
    throw HttpError.badRequest('Le motif de rejet est requis');
  }

  const proofRes = await query(
    `
      SELECT
        pp.*,
        p.client_id,
        p.terrain_id,
        p.id AS payment_id
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
  const oldProofStatus = proof.status;

  await transaction(async (client) => {
    await client.query(
      `
        UPDATE payment_proofs
        SET status = $2,
            reviewed_at = NOW(),
            reviewed_by = $3,
            note = CASE
              WHEN $4::text IS NOT NULL AND $4::text <> ''
                THEN COALESCE(note, '') ||
                     CASE WHEN COALESCE(note, '') = '' THEN '' ELSE E'\n\n' END ||
                     'Review: ' || $4::text
              ELSE note
            END
        WHERE id = $1
      `,
      [proofId, status, userId, reviewNote || null]
    );

    await client.query(
      `
        INSERT INTO payment_history
          (payment_id, action, old_status, new_status, comment, user_id)
        VALUES
          ($1, 'proof_review', NULL, NULL, $2, $3)
      `,
      [
        proof.payment_id,
        `Proof ${oldProofStatus} -> ${status}${reviewNote ? ` | ${reviewNote}` : ''}`,
        userId,
      ]
    );

    await recomputePaymentProofStatus(
      proof.payment_id,
      (sql, params) => client.query(sql, params)
    );
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

  const paymentRes = await query(
    `
      SELECT
        p.*,
        t.title AS terrain_title,
        t.ref AS terrain_ref
      FROM payments p
      LEFT JOIN terrains t ON t.id = p.terrain_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [proof.payment_id]
  );

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
      }).catch((err) => logger.warn(`[PaymentProofReview] Notification failed: ${err.message}`));
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

module.exports = {
  listPaymentProofsForReview,
  reviewPaymentProof,
  recomputePaymentProofStatus,
};