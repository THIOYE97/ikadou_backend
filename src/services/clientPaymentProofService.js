const { query, transaction } = require('../data/db');
const clientProjectAutomationService = require('./clientProjectAutomationService');
const HttpError = require('../utils/httpError');

const CLIENT_PAYMENT_SELECT = `
  SELECT
    p.id,
    p.ref,
    p.amount,
    p.currency,
    p.status,
    p.provider,
    p.provider_ref,
    p.provider_status,
    p.method_type,
    p.payment_method,
    p.payment_purpose,
    p.checkout_url,
    p.expires_at,
    p.notes,
    p.created_at,
    p.updated_at,
    p.reference_code,
    p.client_instruction_note,
    p.proof_status,
    p.project_id,
    p.client_id,
    p.terrain_id,
    t.title AS terrain_title,
    t.ref AS terrain_ref,
    t.location AS terrain_location
  FROM payments p
  LEFT JOIN terrains t ON t.id = p.terrain_id
`;

const ALLOWED_PAYMENT_METHODS = ['mobile_money', 'bank_transfer', 'cash'];
const ALLOWED_PURPOSES = ['reservation', 'installment', 'balance', 'other'];

async function getClientOrThrow(clientId) {
  const result = await query(
    `
      SELECT id, first_name, last_name, email, phone
      FROM clients
      WHERE id = $1
      LIMIT 1
    `,
    [clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Client introuvable');
  }

  return result.rows[0];
}

async function getTerrainOrThrow(terrainId) {
  const result = await query(
    `
      SELECT id, ref, title, location, price
      FROM terrains
      WHERE id = $1
      LIMIT 1
    `,
    [terrainId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  return result.rows[0];
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

async function getClientPaymentOrThrow(paymentId, clientId) {
  const result = await query(
    `${CLIENT_PAYMENT_SELECT} WHERE p.id = $1 AND p.client_id = $2 LIMIT 1`,
    [paymentId, clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Paiement introuvable');
  }

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

async function listActivePaymentMethodConfigs() {
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
        rules_json
      FROM payment_method_configs
      WHERE is_active = TRUE
      ORDER BY priority ASC, label ASC
    `
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

async function getClientPaymentOptions({ clientId, terrainId = null, projectId = null }) {
  const client = await getClientOrThrow(clientId);

  if (projectId) {
    await getClientProjectOrThrow(projectId, clientId);
  }

  if (terrainId) {
    await getTerrainOrThrow(terrainId);
  }

  const configs = await listActivePaymentMethodConfigs();
  const methods = configs.map(normalizePaymentMethodConfig);

  return {
    recommendedMethod: buildRecommendedMethod(client),
    methods,
  };
}

async function createClientPaymentRequest({
  clientId,
  terrainId,
  projectId = null,
  amount,
  reason = 'other',
  paymentMethod,
  note = null,
}) {
  if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
    throw HttpError.badRequest('Mode de paiement invalide');
  }

  if (!ALLOWED_PURPOSES.includes(reason)) {
    throw HttpError.badRequest('Motif de paiement invalide');
  }

  const [client, terrain] = await Promise.all([
    getClientOrThrow(clientId),
    getTerrainOrThrow(terrainId),
  ]);

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

  const configs = await listActivePaymentMethodConfigs();
  const selectedMethodRow = configs.find((item) => item.code === paymentMethod);

  if (!selectedMethodRow) {
    throw HttpError.badRequest("Ce mode de paiement n'est pas disponible pour le moment.");
  }

  const selectedMethod = normalizePaymentMethodConfig(selectedMethodRow);

  const payment = await transaction(async (clientDb) => {
    const paymentRes = await clientDb.query(
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

    const createdPayment = paymentRes.rows[0];

    await clientDb.query(
      `
        INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
        VALUES ($1, 'client_payment_created', NULL, 'pending', $2, NULL)
      `,
      [createdPayment.id, `Paiement créé par le client via ${paymentMethod}`]
    );

    if (projectId) {
      await clientDb.query(
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
                'payment_id', to_jsonb($2::text)
              ),
              true
            ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [projectId, createdPayment.id]
      );
    }

    return createdPayment;
  });

  let effectiveProjectId = payment.project_id || projectId || null;

  if (!effectiveProjectId) {
    const autoProject = await clientProjectAutomationService.upsertProjectFromPayment({
      clientId,
      terrainId,
      paymentId: payment.id,
      paymentStatus: payment.status,
    });

    effectiveProjectId = autoProject?.id || null;

    if (effectiveProjectId) {
      await query(
        `
          UPDATE payments
          SET project_id = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [payment.id, effectiveProjectId]
      );
    }
  }

  return {
    id: payment.id,
    paymentId: payment.id,
    projectId: effectiveProjectId,
    reference_code: payment.reference_code || payment.ref || null,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod,
    purpose: reason,
    terrain: {
      id: terrain.id,
      title: terrain.title,
      ref: terrain.ref,
    },
    client: {
      id: client.id,
      firstName: client.first_name,
      lastName: client.last_name,
      phone: client.phone,
      email: client.email,
    },
    instructions: selectedMethod.instructions,
    clientInstructionNote: payment.client_instruction_note,
    message: 'Paiement créé avec succès',
  };
}

async function listClientPayments({ clientId, page = 1, limit = 20 }) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await query(
    `SELECT COUNT(*) FROM payments WHERE client_id = $1`,
    [clientId]
  );
  const total = Number(countRes.rows[0]?.count || 0);

  const rows = await query(
    `
      ${CLIENT_PAYMENT_SELECT}
      WHERE p.client_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [clientId, safeLimit, offset]
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

async function getClientPaymentReference(paymentId, clientId) {
  const payment = await getClientPaymentOrThrow(paymentId, clientId);

  const methodConfigs = await listActivePaymentMethodConfigs();
  const selectedMethodRow = methodConfigs.find((item) => item.code === payment.payment_method);
  const selectedMethod = selectedMethodRow
    ? normalizePaymentMethodConfig(selectedMethodRow)
    : null;

  return {
    id: payment.id,
    reference_code: payment.reference_code || payment.ref || null,
    ref: payment.ref,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    payment_method: payment.payment_method,
    payment_purpose: payment.payment_purpose,
    client_instruction_note: payment.client_instruction_note,
    project_id: payment.project_id,
    terrain: {
      id: payment.terrain_id,
      title: payment.terrain_title,
      ref: payment.terrain_ref,
      location: payment.terrain_location,
    },
    instructions: selectedMethod?.instructions || {},
  };
}

async function listPaymentProofs(paymentId, clientId) {
  await getClientPaymentOrThrow(paymentId, clientId);

  const result = await query(
    `
      SELECT
        pp.*,
        COALESCE(
          (
            SELECT json_agg(ppf ORDER BY ppf.created_at ASC)
            FROM payment_proof_files ppf
            WHERE ppf.payment_proof_id = pp.id
          ),
          '[]'::json
        ) AS files
      FROM payment_proofs pp
      WHERE pp.payment_id = $1
      ORDER BY pp.submitted_at DESC
    `,
    [paymentId]
  );

  return result.rows;
}

async function createPaymentProof({ paymentId, clientId, note = null, files = [] }) {
  const payment = await getClientPaymentOrThrow(paymentId, clientId);

  const proof = await transaction(async (clientDb) => {
    const proofRes = await clientDb.query(
      `
        INSERT INTO payment_proofs (
          payment_id,
          client_id,
          status,
          note,
          submitted_at
        )
        VALUES ($1, $2, 'submitted', $3, NOW())
        RETURNING *
      `,
      [paymentId, clientId, note || null]
    );

    const createdProof = proofRes.rows[0];

    for (const file of files) {
      await clientDb.query(
        `
          INSERT INTO payment_proof_files (
            payment_proof_id,
            file_url,
            file_storage_key,
            file_type,
            size_bytes
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          createdProof.id,
          file.url,
          file.storageKey,
          file.fileType,
          file.sizeBytes,
        ]
      );
    }

    await clientDb.query(
      `
        UPDATE payments
        SET proof_status = 'submitted',
            updated_at = NOW()
        WHERE id = $1
      `,
      [paymentId]
    );

    await clientDb.query(
      `
        INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
        VALUES ($1, 'proof_submitted', NULL, NULL, $2, NULL)
      `,
      [paymentId, 'Preuve de paiement envoyée par le client']
    );

    return createdProof;
  });

  const proofRows = await query(
    `
      SELECT
        pp.*,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', ppf.id,
                'file_url', ppf.file_url,
                'file_storage_key', ppf.file_storage_key,
                'file_type', ppf.file_type,
                'size_bytes', ppf.size_bytes,
                'created_at', ppf.created_at
              )
              ORDER BY ppf.created_at ASC
            )
            FROM payment_proof_files ppf
            WHERE ppf.payment_proof_id = pp.id
          ),
          '[]'::json
        ) AS files
      FROM payment_proofs pp
      WHERE pp.id = $1
      LIMIT 1
    `,
    [proof.id]
  );

  return {
    proof: proofRows.rows[0],
    payment: {
      id: payment.id,
      status: payment.status,
      proof_status: 'submitted',
    },
    message: 'Preuve de paiement envoyée avec succès',
  };
}
module.exports = {
  getClientPaymentOptions,
  createClientPaymentRequest,
  listClientPayments,
  getClientPaymentReference,
  listPaymentProofs,
  createPaymentProof,
};