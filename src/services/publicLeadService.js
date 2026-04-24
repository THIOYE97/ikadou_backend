const { query } = require('../data/db');
const HttpError = require('../utils/httpError');

async function assertPublishedTerrain(terrainId) {
  const terrainCheck = await query(
    `SELECT id
     FROM terrains
     WHERE id = $1
       AND status = 'published'`,
    [terrainId]
  );

  if (!terrainCheck.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }
}

async function findExistingLeadByEmailOrPhone({ email, phone }) {
  const result = await query(
    `SELECT *
     FROM leads
     WHERE ($1::varchar IS NOT NULL AND LOWER(email) = LOWER($1))
        OR phone = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [email || null, phone]
  );

  return result.rows[0] || null;
}

async function upsertPublicLead({
  firstName,
  lastName,
  phone,
  email = null,
  terrainId = null,
  message = null,
  source = 'mobile_app',
}) {
  const existing = await findExistingLeadByEmailOrPhone({ email, phone });

  let lead;

  if (existing) {
    const updated = await query(
      `UPDATE leads
       SET first_name = $2,
           last_name = $3,
           email = COALESCE($4, email),
           phone = COALESCE($5, phone),
           terrain_id = COALESCE($6, terrain_id),
           message = COALESCE($7, message),
           source = $8,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        existing.id,
        firstName,
        lastName,
        email || null,
        phone,
        terrainId || null,
        message || null,
        source,
      ]
    );
    lead = updated.rows[0];
  } else {
    const inserted = await query(
      `INSERT INTO leads
        (first_name, last_name, email, phone, source, status, terrain_id, message)
       VALUES ($1, $2, $3, $4, $5, 'new', $6, $7)
       RETURNING *`,
      [
        firstName,
        lastName,
        email || null,
        phone,
        source,
        terrainId || null,
        message || null,
      ]
    );
    lead = inserted.rows[0];
  }

  return lead;
}

async function createPublicLead(payload) {
  return upsertPublicLead({
    ...payload,
    source: 'mobile_app',
  });
}

async function createTerrainContactLead(terrainId, payload) {
  await assertPublishedTerrain(terrainId);

  return upsertPublicLead({
    ...payload,
    terrainId,
    source: 'mobile_app',
  });
}

module.exports = {
  createPublicLead,
  createTerrainContactLead,
};