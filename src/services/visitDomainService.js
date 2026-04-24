const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const notificationService = require('./notificationService');
const clientProjectAutomationService = require('./clientProjectAutomationService');

const ACTIVE_VISIT_STATUSES = ['scheduled', 'confirmed', 'done', 'rescheduled'];
const NON_BLOCKING_VISIT_STATUSES = ['cancelled', 'no_show'];
const CLIENT_VISIBLE_SLOTS = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00'];

const VISIT_STATUS_TRANSITIONS = {
  scheduled: ['confirmed', 'done', 'cancelled', 'rescheduled', 'no_show'],
  confirmed: ['done', 'cancelled', 'rescheduled', 'no_show'],
  rescheduled: ['confirmed', 'done', 'cancelled', 'no_show'],
  done: [],
  cancelled: [],
  no_show: [],
};

async function getTerrainOrThrow(terrainId, { publishedOnly = false } = {}) {
  const result = await query(
    `SELECT id, title, ref, status, location, images
     FROM terrains
     WHERE id = $1`,
    [terrainId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  const terrain = result.rows[0];

  if (publishedOnly && terrain.status !== 'published') {
    throw HttpError.notFound('Terrain introuvable');
  }

  return terrain;
}

async function getClientProjectOrThrow(projectId, clientId) {
  const result = await query(
    `
      SELECT id, client_id, terrain_id, title, status, current_step, steps, metadata
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

async function resolveTerrainForClientVisit({ terrainId = null, projectId = null, clientId, publishedOnly = true }) {
  let project = null;
  let finalTerrainId = terrainId || null;

  if (projectId) {
    project = await getClientProjectOrThrow(projectId, clientId);

    if (!finalTerrainId && project.terrain_id) {
      finalTerrainId = project.terrain_id;
    }
  }

  if (!finalTerrainId) {
    throw HttpError.badRequest(
      "Aucun terrain n'est encore lié à ce projet. Veuillez d'abord sélectionner un terrain avant de confirmer la visite."
    );
  }

  const terrain = await getTerrainOrThrow(finalTerrainId, { publishedOnly });

  return {
    project,
    terrain,
    terrainId: finalTerrainId,
  };
}

async function getVisitByIdOrThrow(visitId) {
  const result = await query(
    `SELECT *
     FROM visits
     WHERE id = $1`,
    [visitId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Visite introuvable');
  }

  return result.rows[0];
}

async function getVisitForClientOrThrow(visitId, clientId) {
  const result = await query(
    `SELECT *
     FROM visits
     WHERE id = $1 AND client_id = $2`,
    [visitId, clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Visite introuvable');
  }

  return result.rows[0];
}

async function assertAgentSlotAvailable({ agentId, visitDate, visitTime, excludeVisitId = null }) {
  if (!agentId) return;

  const params = [agentId, visitDate, visitTime];
  let excludeSql = '';

  if (excludeVisitId) {
    params.push(excludeVisitId);
    excludeSql = `AND id != $${params.length}`;
  }

  const conflict = await query(
    `SELECT id
     FROM visits
     WHERE agent_id = $1
       AND visit_date = $2
       AND ABS(EXTRACT(EPOCH FROM (visit_time::time - $3::time))) < 1800
       AND status NOT IN ('cancelled', 'no_show')
       ${excludeSql}`,
    params
  );

  if (conflict.rows.length) {
    throw HttpError.conflict("L'agent a déjà une visite sur ce créneau (±30 min)");
  }
}

async function assertTerrainSlotAvailable({ terrainId, visitDate, visitTime, excludeVisitId = null }) {
  const params = [terrainId, visitDate, visitTime];
  let excludeSql = '';

  if (excludeVisitId) {
    params.push(excludeVisitId);
    excludeSql = `AND id != $${params.length}`;
  }

  const conflict = await query(
    `SELECT id
     FROM visits
     WHERE terrain_id = $1
       AND visit_date = $2
       AND visit_time = $3
       AND status NOT IN ('cancelled', 'no_show')
       ${excludeSql}`,
    params
  );

  if (conflict.rows.length) {
    throw HttpError.conflict('Ce créneau n’est plus disponible');
  }
}

async function createVisit({
  terrainId,
  projectId = null,
  visitDate,
  visitTime,
  agentId = null,
  clientId = null,
  leadId = null,
  notes = null,
  createdBy = null,
  source = 'backoffice',
}) {
  if (!clientId && !leadId) {
    throw HttpError.badRequest('Un client ou un lead doit être associé à la visite');
  }

  await getTerrainOrThrow(terrainId, { publishedOnly: false });
  await assertAgentSlotAvailable({ agentId, visitDate, visitTime });

  const result = await query(
    `INSERT INTO visits
      (terrain_id, project_id, visit_date, visit_time, agent_id, client_id, lead_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [terrainId, projectId, visitDate, visitTime, agentId, clientId, leadId, notes, createdBy]
  );

  const visit = result.rows[0];

  await query(
    `INSERT INTO visit_history (visit_id, action, new_value, comment, user_id)
     VALUES ($1, 'created', $2, $3, $4)`,
    [
      visit.id,
      JSON.stringify({
        status: 'scheduled',
        visit_date: visitDate,
        visit_time: visitTime,
        project_id: projectId || null,
      }),
      source === 'mobile_app' ? 'Créé depuis l’application mobile' : null,
      createdBy,
    ]
  );
if (clientId) {
  notifyVisitSafely('created', visit.id).catch(() => {});
}
  return visit;
}

async function createClientVisit({ terrainId, projectId = null, visitDate, visitTime, clientId, notes = null }) {
  const resolved = await resolveTerrainForClientVisit({
    terrainId,
    projectId,
    clientId,
    publishedOnly: true,
  });

  await assertTerrainSlotAvailable({
    terrainId: resolved.terrainId,
    visitDate,
    visitTime,
  });

  const createdVisit = await createVisit({
    terrainId: resolved.terrainId,
    projectId: projectId || null,
    visitDate,
    visitTime,
    clientId,
    notes,
    createdBy: null,
    source: 'mobile_app',
  });

  let effectiveProjectId = createdVisit.project_id || projectId || null;

  if (!effectiveProjectId) {
    const autoProject = await clientProjectAutomationService.upsertProjectFromVisit({
      clientId,
      terrainId: resolved.terrainId,
      visitId: createdVisit.id,
      visitStatus: createdVisit.status,
    });

    effectiveProjectId = autoProject?.id || null;
  }

  return {
    ...createdVisit,
    project_id: effectiveProjectId,
  };
}
async function listVisits({ status, agent_id, from_date, to_date, page = 1, limit = 20 }) {
  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`v.status = $${params.length}`);
  }
  if (agent_id) {
    params.push(agent_id);
    conditions.push(`v.agent_id = $${params.length}`);
  }
  if (from_date) {
    params.push(from_date);
    conditions.push(`v.visit_date >= $${params.length}`);
  }
  if (to_date) {
    params.push(to_date);
    conditions.push(`v.visit_date <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await query(`SELECT COUNT(*) FROM visits v ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(safeLimit, offset);
  const rows = await query(
    `SELECT
       v.id, v.project_id, v.visit_date, v.visit_time, v.status, v.notes,
       v.created_at, v.updated_at,
       t.title AS terrain_title, t.ref AS terrain_ref,
       a.first_name || ' ' || a.last_name AS agent_name, v.agent_id,
       COALESCE(c.first_name || ' ' || c.last_name, l.first_name || ' ' || l.last_name) AS client_name,
       v.client_id, v.lead_id
     FROM visits v
     LEFT JOIN terrains t ON v.terrain_id = t.id
     LEFT JOIN agents a ON v.agent_id = a.id
     LEFT JOIN clients c ON v.client_id = c.id
     LEFT JOIN leads l ON v.lead_id = l.id
     ${where}
     ORDER BY v.visit_date ASC, v.visit_time ASC
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

async function getVisitDetail(visitId) {
  const result = await query(
    `SELECT
       v.*,
       t.title AS terrain_title, t.ref AS terrain_ref,
       a.first_name || ' ' || a.last_name AS agent_name,
       c.first_name || ' ' || c.last_name AS client_name,
       l.first_name || ' ' || l.last_name AS lead_name
     FROM visits v
     LEFT JOIN terrains t ON v.terrain_id = t.id
     LEFT JOIN agents a ON v.agent_id = a.id
     LEFT JOIN clients c ON v.client_id = c.id
     LEFT JOIN leads l ON v.lead_id = l.id
     WHERE v.id = $1`,
    [visitId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Visite introuvable');
  }

  const history = await query(
    `SELECT vh.*, u.first_name || ' ' || u.last_name AS author
     FROM visit_history vh
     LEFT JOIN internal_users u ON vh.user_id = u.id
     WHERE vh.visit_id = $1
     ORDER BY vh.created_at DESC`,
    [visitId]
  );

  return {
    ...result.rows[0],
    history: history.rows,
  };
}

async function getClientVisitDetail(visitId, clientId) {
  const visit = await query(
    `SELECT
       v.*,
       t.title AS terrain_title,
       t.ref AS terrain_ref,
       t.location AS terrain_location,
       t.images AS terrain_images,
       a.first_name || ' ' || a.last_name AS agent_name
     FROM visits v
     LEFT JOIN terrains t ON t.id = v.terrain_id
     LEFT JOIN agents a ON a.id = v.agent_id
     WHERE v.id = $1
       AND v.client_id = $2`,
    [visitId, clientId]
  );

  if (!visit.rows.length) {
    throw HttpError.notFound('Visite introuvable');
  }

  const history = await query(
    `SELECT *
     FROM visit_history
     WHERE visit_id = $1
     ORDER BY created_at DESC`,
    [visitId]
  );

  return {
    ...visit.rows[0],
    history: history.rows,
  };
}

async function getClientVisits(clientId) {
  const result = await query(
    `SELECT
       v.id,
       v.project_id,
       v.visit_date,
       v.visit_time,
       v.status,
       v.notes,
       v.cancel_reason,
       v.created_at,
       v.updated_at,
       t.id AS terrain_id,
       t.title AS terrain_title,
       t.ref AS terrain_ref,
       t.location AS terrain_location,
       t.images AS terrain_images,
       a.first_name || ' ' || a.last_name AS agent_name
     FROM visits v
     LEFT JOIN terrains t ON t.id = v.terrain_id
     LEFT JOIN agents a ON a.id = v.agent_id
     WHERE v.client_id = $1
     ORDER BY v.visit_date ASC, v.visit_time ASC`,
    [clientId]
  );

  return result.rows;
}

async function searchClientSlots({ terrainId = null, projectId = null, clientId, date }) {
  const resolved = await resolveTerrainForClientVisit({
    terrainId,
    projectId,
    clientId,
    publishedOnly: true,
  });

  const taken = await query(
    `SELECT visit_time
     FROM visits
     WHERE terrain_id = $1
       AND visit_date = $2
       AND status NOT IN ('cancelled', 'no_show')`,
    [resolved.terrainId, date]
  );

  const busyTimes = new Set(taken.rows.map((r) => String(r.visit_time).slice(0, 5)));

  return {
    projectId: projectId || null,
    terrainId: resolved.terrainId,
    date,
    slots: CLIENT_VISIBLE_SLOTS.map((time) => ({
      time,
      available: !busyTimes.has(time),
    })),
  };
}

async function changeVisitStatus({ visitId, status, reason = null, userId }) {
  const existing = await query(
    `SELECT *
     FROM visits
     WHERE id = $1`,
    [visitId]
  );

  if (!existing.rows.length) {
    throw HttpError.notFound('Visite introuvable');
  }

  const visit = existing.rows[0];
  const oldStatus = visit.status;

  await transaction(async (client) => {
    await client.query(
      `
        UPDATE visits
        SET status = $1,
            cancel_reason = $2,
            updated_at = NOW()
        WHERE id = $3
      `,
      [status, reason || null, visitId]
    );

    await client.query(
      `
        INSERT INTO visit_history
          (visit_id, action, old_value, new_value, comment, user_id)
        VALUES
          ($1, 'status_changed', $2, $3, $4, $5)
      `,
      [visitId, oldStatus, status, reason || null, userId]
    );
  });

  const updated = await query(
    `SELECT *
     FROM visits
     WHERE id = $1`,
    [visitId]
  );
 if (updated.rows[0]?.client_id && oldStatus !== status) {
  const notifyType =
    status === 'confirmed'
      ? 'confirmed'
      : status === 'done'
      ? 'done'
      : status === 'cancelled'
      ? 'cancelled'
      : status === 'rescheduled'
      ? 'rescheduled'
      : null;

  if (notifyType) {
    notifyVisitSafely(notifyType, visitId, { reason }).catch(() => {});
  }
}
  return updated.rows[0];
}

async function rescheduleClientVisit({ visitId, clientId, visitDate, visitTime, reason = null }) {
  const existing = await getVisitForClientOrThrow(visitId, clientId);

  await assertTerrainSlotAvailable({
    terrainId: existing.terrain_id,
    visitDate,
    visitTime,
    excludeVisitId: visitId,
  });

  await transaction(async (client) => {
    await client.query(
      `UPDATE visits
       SET visit_date = $1,
           visit_time = $2,
           status = 'rescheduled',
           updated_at = NOW()
       WHERE id = $3`,
      [visitDate, visitTime, visitId]
    );

    await client.query(
      `INSERT INTO visit_history (visit_id, action, old_value, new_value, comment, user_id)
       VALUES ($1, 'rescheduled', $2, $3, $4, NULL)`,
      [
        visitId,
        `${existing.visit_date} ${String(existing.visit_time).slice(0, 5)}`,
        `${visitDate} ${visitTime}`,
        reason || 'Replanifié depuis l’application mobile',
      ]
    );
  });

  const updated = await getVisitByIdOrThrow(visitId);
notifyVisitSafely('rescheduled', visitId).catch(() => {});
return updated;
}

async function loadVisitNotificationContext(visitId) {
  const result = await query(
    `
      SELECT
        v.*,
        c.id AS client_id,
        c.first_name,
        c.last_name,
        c.email,
        c.phone,
        c.push_token,
        t.id AS terrain_id,
        t.title AS terrain_title,
        t.ref AS terrain_ref,
        a.id AS agent_id,
        a.first_name AS agent_first_name,
        a.last_name AS agent_last_name,
        a.phone AS agent_phone
      FROM visits v
      LEFT JOIN clients c ON c.id = v.client_id
      LEFT JOIN terrains t ON t.id = v.terrain_id
      LEFT JOIN agents a ON a.id = v.agent_id
      WHERE v.id = $1
      LIMIT 1
    `,
    [visitId]
  );

  const row = result.rows[0];
  if (!row || !row.client_id || !row.email) return null;

  return {
    visit: row,
    client: {
      id: row.client_id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
      push_token: row.push_token,
    },
    terrain: {
      id: row.terrain_id,
      title: row.terrain_title,
      ref: row.terrain_ref,
    },
    agent: row.agent_id
      ? {
          id: row.agent_id,
          first_name: row.agent_first_name,
          last_name: row.agent_last_name,
          phone: row.agent_phone,
        }
      : null,
  };
}

async function notifyVisitSafely(type, visitId, extra = {}) {
  try {
    const ctx = await loadVisitNotificationContext(visitId);
    if (!ctx) return;

    if (type === 'created') {
      await notificationService.notifyVisitCreated(ctx);
    } else if (type === 'confirmed') {
      await notificationService.notifyVisitConfirmed(ctx);
    } else if (type === 'done') {
      await notificationService.notifyVisitCompleted(ctx);
    } else if (type === 'cancelled') {
      await notificationService.notifyVisitCancelled({
        ...ctx,
        reason: extra.reason,
      });
    } else if (type === 'rescheduled') {
      await notificationService.notifyVisitRescheduled(ctx);
    }
  } catch (_) {}
}

async function cancelClientVisit({ visitId, clientId, reason = null }) {
  const existing = await getVisitForClientOrThrow(visitId, clientId);

  if (NON_BLOCKING_VISIT_STATUSES.includes(existing.status)) {
    return existing;
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE visits
       SET status = 'cancelled',
           cancel_reason = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [reason || null, visitId]
    );

    await client.query(
      `INSERT INTO visit_history (visit_id, action, field, old_value, new_value, comment, user_id)
       VALUES ($1, 'status_changed', 'status', $2, 'cancelled', $3, NULL)`,
      [visitId, existing.status, reason || 'Annulé depuis l’application mobile']
    );
  });

  const updated = await getVisitByIdOrThrow(visitId);
notifyVisitSafely('cancelled', visitId, { reason }).catch(() => {});
return updated;
}

module.exports = {
  createVisit,
  createClientVisit,
  listVisits,
  getVisitDetail,
  getClientVisitDetail,
  getClientVisits,
  searchClientSlots,
  changeVisitStatus,
  rescheduleClientVisit,
  cancelClientVisit,
  VISIT_STATUS_TRANSITIONS,
  ACTIVE_VISIT_STATUSES,
};