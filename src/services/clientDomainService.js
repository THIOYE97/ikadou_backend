const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');

const CLIENT_STATUS_TRANSITIONS = {
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};

async function getClientOrThrow(clientId) {
  const result = await query(
    `SELECT *
     FROM clients
     WHERE id = $1`,
    [clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Client introuvable');
  }

  return result.rows[0];
}

async function listClients({ search, status, page = 1, limit = 20 }) {
  const params = [];
  const conditions = [];

  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conditions.push(
      `(first_name ILIKE $${n} OR last_name ILIKE $${n} OR email ILIKE $${n} OR phone ILIKE $${n})`
    );
  }

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await query(
    `SELECT COUNT(*) FROM clients ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(safeLimit, offset);
  const rows = await query(
    `SELECT
       id, first_name, last_name, email, phone, country, city,
       status, kyc_verified, created_at, updated_at
     FROM clients ${where}
     ORDER BY created_at DESC
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

async function createClient({
  firstName,
  lastName,
  email = null,
  phone = null,
  country = null,
  city = null,
}) {
  const result = await query(
    `INSERT INTO clients (first_name, last_name, email, phone, country, city)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [firstName, lastName, email, phone, country, city]
  );

  return result.rows[0];
}

async function getClient360(clientId) {
  const client = await getClientOrThrow(clientId);

  const [leads, visits, payments, docs, tickets] = await Promise.all([
    query(
      `SELECT id, first_name, last_name, status, source, created_at
       FROM leads
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [clientId]
    ),
    query(
      `SELECT
         v.id,
         v.visit_date,
         v.visit_time,
         v.status,
         v.notes,
         v.cancel_reason,
         t.title AS terrain_title,
         t.ref AS terrain_ref
       FROM visits v
       LEFT JOIN terrains t ON v.terrain_id = t.id
       WHERE v.client_id = $1
       ORDER BY v.visit_date DESC, v.visit_time DESC
       LIMIT 10`,
      [clientId]
    ),
    query(
      `SELECT
         id, ref, amount, currency, status, created_at, provider
       FROM payments
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [clientId]
    ),
    query(
      `SELECT
         id, name, type, created_at, url
       FROM documents
       WHERE related_type = 'client'
         AND related_id = $1
       ORDER BY created_at DESC`,
      [clientId]
    ),
    query(
      `SELECT
         id, ref, subject, status, priority, created_at
       FROM support_tickets
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [clientId]
    ),
  ]);

  return {
    ...client,
    leads: leads.rows,
    visits: visits.rows,
    payments: payments.rows,
    documents: docs.rows,
    tickets: tickets.rows,
  };
}

async function updateClient(clientId, payload) {
  await getClientOrThrow(clientId);

  const {
    firstName,
    lastName,
    email,
    phone,
    country,
    city,
    kycVerified,
  } = payload;

  const fields = [];
  const params = [];

  if (firstName !== undefined) {
    params.push(firstName);
    fields.push(`first_name = $${params.length}`);
  }
  if (lastName !== undefined) {
    params.push(lastName);
    fields.push(`last_name = $${params.length}`);
  }
  if (email !== undefined) {
    params.push(email);
    fields.push(`email = $${params.length}`);
  }
  if (phone !== undefined) {
    params.push(phone);
    fields.push(`phone = $${params.length}`);
  }
  if (country !== undefined) {
    params.push(country);
    fields.push(`country = $${params.length}`);
  }
  if (city !== undefined) {
    params.push(city);
    fields.push(`city = $${params.length}`);
  }
  if (kycVerified !== undefined) {
    params.push(kycVerified);
    fields.push(`kyc_verified = $${params.length}`);
  }

  if (!fields.length) {
    throw HttpError.badRequest('Aucun champ à mettre à jour');
  }

  params.push(clientId);
  const result = await query(
    `UPDATE clients
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  return result.rows[0];
}

async function changeClientStatus({
  clientId,
  status,
  reason = null,
  userId,
}) {
  const existing = await getClientOrThrow(clientId);
  const allowed = CLIENT_STATUS_TRANSITIONS[existing.status] || [];

  if (!allowed.includes(status)) {
    throw HttpError.badRequest(`Transition invalide: ${existing.status} -> ${status}`);
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE clients
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [status, clientId]
    );

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'client', $3, $4)`,
      [
        userId,
        `client_status_changed_to_${status}`,
        clientId,
        JSON.stringify({
          old: existing.status,
          new: status,
          reason,
        }),
      ]
    );
  });

  return getClientOrThrow(clientId);
}

/**
 * MOBILE / CLIENT SIDE
 * Lecture du profil du client connecté.
 * Même table `clients`, mêmes données source, mais projection réduite.
 */
async function getClientProfile(clientId) {
  const result = await query(
    `SELECT
       id,
       first_name,
       last_name,
       email,
       phone,
       country,
       city,
       status,
       kyc_verified,
       created_at,
       updated_at
     FROM clients
     WHERE id = $1`,
    [clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Client introuvable');
  }

  return result.rows[0];
}

/**
 * MOBILE / CLIENT SIDE
 * Mise à jour limitée aux champs autorisés côté app mobile.
 * On met aussi à jour `client_auth_accounts` quand email/téléphone changent.
 */
async function updateClientProfile(clientId, payload) {
  const existing = await getClientOrThrow(clientId);

  const {
    firstName,
    lastName,
    email,
    phone,
    country,
    city,
  } = payload;

  const fields = [];
  const params = [];

  const set = (column, value) => {
    if (value !== undefined) {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    }
  };

  set('first_name', firstName);
  set('last_name', lastName);
  set('email', email);
  set('phone', phone);
  set('country', country);
  set('city', city);

  if (!fields.length) {
    throw HttpError.badRequest('Aucun champ à mettre à jour');
  }

  let updatedClient;

  await transaction(async (client) => {
    params.push(clientId);

    const updated = await client.query(
      `UPDATE clients
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING
         id, first_name, last_name, email, phone,
         country, city, status, kyc_verified, created_at, updated_at`,
      params
    );

    if (!updated.rows.length) {
      throw HttpError.notFound('Client introuvable');
    }

    updatedClient = updated.rows[0];

    const authFields = [];
    const authParams = [];

    if (email !== undefined) {
      authParams.push(email);
      authFields.push(`email = $${authParams.length}`);
      authFields.push(`is_email_verified = FALSE`);
    }

    if (phone !== undefined) {
      authParams.push(phone);
      authFields.push(`phone = $${authParams.length}`);
      authFields.push(`is_phone_verified = FALSE`);
    }

    if (authFields.length) {
      authParams.push(clientId);

      await client.query(
        `UPDATE client_auth_accounts
         SET ${authFields.join(', ')}, updated_at = NOW()
         WHERE client_id = $${authParams.length}`,
        authParams
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'client', $3, $4)`,
      [
        clientId,
        'client_profile_updated_by_self',
        clientId,
        JSON.stringify({
          old: {
            first_name: existing.first_name,
            last_name: existing.last_name,
            email: existing.email,
            phone: existing.phone,
            country: existing.country,
            city: existing.city,
          },
          new: {
            first_name: updatedClient.first_name,
            last_name: updatedClient.last_name,
            email: updatedClient.email,
            phone: updatedClient.phone,
            country: updatedClient.country,
            city: updatedClient.city,
          },
        }),
      ]
    );
  });

  return updatedClient;
}

async function getClientAppState(clientId) {
  const result = await query(
    `SELECT *
     FROM client_app_state
     WHERE client_id = $1`,
    [clientId]
  );

  return result.rows[0] || null;
}

async function completeClientOnboarding(clientId, version = null) {
  const result = await query(
    `UPDATE client_app_state
     SET onboarding_completed = TRUE,
         onboarding_completed_at = NOW(),
         onboarding_version = COALESCE($2, onboarding_version),
         updated_at = NOW()
     WHERE client_id = $1
     RETURNING *`,
    [clientId, version]
  );

  return result.rows[0] || null;
}

async function getClientNotificationPrefs(clientId) {
  await query(
    `INSERT INTO client_notification_prefs (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );

  const result = await query(
    `SELECT *
     FROM client_notification_prefs
     WHERE client_id = $1`,
    [clientId]
  );

  return result.rows[0] || null;
}

async function updateClientNotificationPrefs(clientId, payload) {
  await query(
    `INSERT INTO client_notification_prefs (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );

  const {
    emailEnabled,
    smsEnabled,
    pushEnabled,
    whatsappEnabled,
    visitNotifs,
    paymentNotifs,
    promoNotifs,
  } = payload;

  const fields = [];
  const params = [];

  const set = (col, val) => {
    if (val !== undefined) {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    }
  };

  set('email_enabled', emailEnabled);
  set('sms_enabled', smsEnabled);
  set('push_enabled', pushEnabled);
  set('whatsapp_enabled', whatsappEnabled);
  set('visit_notifs', visitNotifs);
  set('payment_notifs', paymentNotifs);
  set('promo_notifs', promoNotifs);

  if (!fields.length) {
    throw HttpError.badRequest('Aucun champ à mettre à jour');
  }

  params.push(clientId);

  const result = await query(
    `UPDATE client_notification_prefs
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE client_id = $${params.length}
     RETURNING *`,
    params
  );

  return result.rows[0] || null;
}

module.exports = {
  CLIENT_STATUS_TRANSITIONS,
  listClients,
  createClient,
  getClient360,
  updateClient,
  changeClientStatus,
  getClientProfile,
  updateClientProfile,
  getClientAppState,
  completeClientOnboarding,
  getClientNotificationPrefs,
  updateClientNotificationPrefs,
};