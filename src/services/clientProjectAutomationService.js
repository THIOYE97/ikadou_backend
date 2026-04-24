const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');

function baseSteps() {
  return {
    simulation: {
      key: 'simulation',
      label: 'Simulation',
      status: 'pending',
    },
    visite: {
      key: 'visite',
      label: 'Visite',
      status: 'pending',
    },
    achat: {
      key: 'achat',
      label: 'Achat',
      status: 'pending',
    },
  };
}

function buildProjectTitle(terrainTitle) {
  return terrainTitle ? `Projet terrain — ${terrainTitle}` : 'Projet terrain';
}

async function getTerrainOrThrow(terrainId) {
  const res = await query(
    `
      SELECT id, title, ref, location, price
      FROM terrains
      WHERE id = $1
      LIMIT 1
    `,
    [terrainId]
  );

  if (!res.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  return res.rows[0];
}

async function findReusableProjectForClientTerrain(clientId, terrainId) {
  const res = await query(
    `
      SELECT
        id,
        client_id,
        terrain_id,
        title,
        status,
        current_step,
        steps,
        metadata,
        created_at,
        updated_at
      FROM client_projects
      WHERE client_id = $1
        AND terrain_id = $2
        AND status IN ('draft', 'in_progress')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [clientId, terrainId]
  );

  return res.rows[0] || null;
}

async function createBaseProject({ clientDb, clientId, terrain, source = 'auto' }) {
  const steps = baseSteps();
  const metadata = {
    source,
    auto_created: true,
  };

  const res = await clientDb.query(
    `
      INSERT INTO client_projects (
        client_id,
        terrain_id,
        title,
        status,
        current_step,
        steps,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, 'in_progress', 'simulation', $4::jsonb, $5::jsonb, NOW(), NOW()
      )
      RETURNING *
    `,
    [
      clientId,
      terrain.id,
      buildProjectTitle(terrain.title),
      JSON.stringify(steps),
      JSON.stringify(metadata),
    ]
  );

  return res.rows[0];
}

function ensureStepsObject(project) {
  return project?.steps && typeof project.steps === 'object'
    ? project.steps
    : baseSteps();
}

async function saveProjectState({
  clientDb,
  projectId,
  title,
  currentStep,
  status = 'in_progress',
  steps,
  metadata = {},
}) {
  const res = await clientDb.query(
    `
      UPDATE client_projects
      SET
        title = COALESCE($2, title),
        current_step = $3,
        status = $4,
        steps = $5::jsonb,
        metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      projectId,
      title || null,
      currentStep,
      status,
      JSON.stringify(steps),
      JSON.stringify(metadata || {}),
    ]
  );

  return res.rows[0];
}

async function attachVisitToExistingProject({ clientDb, projectId, visitId }) {
  await clientDb.query(
    `
      UPDATE visits
      SET project_id = $2,
          updated_at = NOW()
      WHERE id = $1
        AND project_id IS NULL
    `,
    [visitId, projectId]
  );
}

async function upsertProjectFromVisit({
  clientId,
  terrainId,
  visitId,
  visitStatus = 'scheduled',
}) {
  const terrain = await getTerrainOrThrow(terrainId);

  return transaction(async (clientDb) => {
    let project = await findReusableProjectForClientTerrain(clientId, terrainId);

    if (!project) {
      project = await createBaseProject({
        clientDb,
        clientId,
        terrain,
        source: 'visit_direct',
      });
    }

    await attachVisitToExistingProject({
      clientDb,
      projectId: project.id,
      visitId,
    });

    const steps = ensureStepsObject(project);
    const visitIsCompleted = ['confirmed', 'done', 'completed'].includes(
      String(visitStatus).toLowerCase()
    );

    steps.simulation = {
      ...(steps.simulation || {}),
      key: 'simulation',
      label: 'Simulation',
      status: 'completed',
      auto_completed: true,
      auto_completed_reason: 'visit_direct',
      completed_at: steps.simulation?.completed_at || new Date().toISOString(),
    };

    steps.visite = {
      ...(steps.visite || {}),
      key: 'visite',
      label: 'Visite',
      status: visitIsCompleted ? 'completed' : 'in_progress',
      visit_id: visitId,
      started_at: steps.visite?.started_at || new Date().toISOString(),
      completed_at: visitIsCompleted
        ? steps.visite?.completed_at || new Date().toISOString()
        : null,
      source: 'visit_direct',
    };

    steps.achat = {
      ...(steps.achat || {}),
      key: 'achat',
      label: 'Achat',
      status: 'pending',
    };

    const saved = await saveProjectState({
      clientDb,
      projectId: project.id,
      title: buildProjectTitle(terrain.title),
      currentStep: visitIsCompleted ? 'achat' : 'visite',
      status: 'in_progress',
      steps,
      metadata: {
        source: 'visit_direct',
        auto_created: true,
        latest_visit_id: visitId,
      },
    });

    return saved;
  });
}

async function upsertProjectFromPayment({
  clientId,
  terrainId,
  paymentId,
  paymentStatus = 'pending',
}) {
  const terrain = await getTerrainOrThrow(terrainId);

  return transaction(async (clientDb) => {
    let project = await findReusableProjectForClientTerrain(clientId, terrainId);

    if (!project) {
      project = await createBaseProject({
        clientDb,
        clientId,
        terrain,
        source: 'payment_direct',
      });
    }

    const steps = ensureStepsObject(project);
    const paymentIsCompleted = ['confirmed', 'done', 'completed'].includes(
      String(paymentStatus).toLowerCase()
    );

    steps.simulation = {
      ...(steps.simulation || {}),
      key: 'simulation',
      label: 'Simulation',
      status: 'completed',
      auto_completed: true,
      auto_completed_reason: 'payment_direct',
      completed_at: steps.simulation?.completed_at || new Date().toISOString(),
    };

    steps.visite = {
      ...(steps.visite || {}),
      key: 'visite',
      label: 'Visite',
      status: 'completed',
      auto_completed: true,
      auto_completed_reason: 'payment_direct',
      completed_at: steps.visite?.completed_at || new Date().toISOString(),
    };

    steps.achat = {
      ...(steps.achat || {}),
      key: 'achat',
      label: 'Achat',
      status: paymentIsCompleted ? 'completed' : 'in_progress',
      payment_id: paymentId,
      started_at: steps.achat?.started_at || new Date().toISOString(),
      completed_at: paymentIsCompleted
        ? steps.achat?.completed_at || new Date().toISOString()
        : null,
      source: 'payment_direct',
    };

    const saved = await saveProjectState({
      clientDb,
      projectId: project.id,
      title: buildProjectTitle(terrain.title),
      currentStep: 'achat',
      status: paymentIsCompleted ? 'completed' : 'in_progress',
      steps,
      metadata: {
        source: 'payment_direct',
        auto_created: true,
        latest_payment_id: paymentId,
      },
    });

    return saved;
  });
}

module.exports = {
  findReusableProjectForClientTerrain,
  upsertProjectFromVisit,
  upsertProjectFromPayment,
};