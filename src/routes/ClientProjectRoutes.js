const express = require('express');
const { body, query: q, param, validationResult } = require('express-validator');
const router = express.Router();

const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const requireClientAuth = require('../middleware/requireClientAuth');

const PROJECT_STEP_KEYS = ['simulation', 'visite', 'achat'];
const ACTIVE_PAYMENT_LOCK_STATUSES = ['pending', 'partial', 'confirmed'];
const VISIT_DONE_STATUSES = ['done'];
const VISIT_ACTIVE_STATUSES = ['scheduled', 'confirmed', 'rescheduled'];
const PAYMENT_DONE_STATUSES = ['confirmed'];
const PAYMENT_FAILED_STATUSES = ['failed', 'cancelled', 'refunded'];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error('Validation failed');
    err.type = 'validation';
    err.errors = errors.array();
    return next(err);
  }
  next();
};

router.use(requireClientAuth);

function getClientId(req) {
  const clientId = req.client?.id;
  if (!clientId) throw HttpError.unauthorized('Client non authentifié');
  return clientId;
}

function nowIso() {
  return new Date().toISOString();
}

function buildInitialSteps() {
  const now = nowIso();
  return {
    simulation: {
      key: 'simulation',
      label: 'Simulation',
      status: 'in_progress',
      started_at: now,
      completed_at: null,
      data: null,
    },
    visite: {
      key: 'visite',
      label: 'Visite',
      status: 'pending',
      started_at: null,
      completed_at: null,
      data: null,
    },
    achat: {
      key: 'achat',
      label: 'Achat',
      status: 'pending',
      started_at: null,
      completed_at: null,
      data: null,
    },
  };
}

function buildProjectListItem(project) {
  return {
    ...project,
    entry_source:
      project?.metadata?.source ||
      project?.source ||
      (project?.steps?.achat?.source === 'payment_direct'
        ? 'payment_direct'
        : project?.steps?.visite?.source === 'visit_direct'
        ? 'visit_direct'
        : 'mobile_app'),
    latest_visit: project?.sync?.latest_visit || null,
    latest_payment: project?.sync?.latest_payment || null,
    reservation_payment: project?.sync?.reservation_payment || null,
    can_cancel: project?.sync?.can_cancel || { allowed: true, reason: null },
  };
}

function normalizeProject(row) {
  return {
    ...row,
    steps: row.steps || buildInitialSteps(),
    metadata: row.metadata || {},
  };
}

async function getTerrainOrThrow(terrainId) {
  const result = await query(
    `
      SELECT id, ref, title, status, location, price, currency
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

async function getProjectOrThrow(projectId, clientId) {
  const result = await query(
    `
      SELECT
        cp.id,
        cp.client_id,
        cp.terrain_id,
        cp.title,
        cp.status,
        cp.current_step,
        cp.steps,
        cp.metadata,
        cp.cancel_reason,
        cp.cancelled_at,
        cp.created_at,
        cp.updated_at,
        t.title AS terrain_title,
        t.ref AS terrain_ref,
        t.location AS terrain_location,
        t.price AS terrain_price,
        t.currency AS terrain_currency
      FROM client_projects cp
      LEFT JOIN terrains t ON t.id = cp.terrain_id
      WHERE cp.id = $1 AND cp.client_id = $2
      LIMIT 1
    `,
    [projectId, clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Projet introuvable');
  }

  return normalizeProject(result.rows[0]);
}

function assertProjectNotClosed(project) {
  if (project.status === 'completed') {
    throw HttpError.badRequest("Ce projet est déjà finalisé et ne peut plus être modifié");
  }

  if (project.status === 'cancelled') {
    throw HttpError.badRequest("Ce projet a été annulé et ne peut plus être modifié");
  }
}

function canCancelProject(project, paymentSync) {
  if (project.status === 'completed') {
    return {
      allowed: false,
      reason: "Le projet est déjà finalisé, il ne peut plus être annulé.",
    };
  }

  if (project.status === 'cancelled') {
    return {
      allowed: false,
      reason: "Ce projet est déjà annulé.",
    };
  }

  if (
    paymentSync?.reservation_payment &&
    ACTIVE_PAYMENT_LOCK_STATUSES.includes(paymentSync.reservation_payment.status)
  ) {
    return {
      allowed: false,
      reason:
        "L'annulation n'est plus possible car un paiement de réservation a déjà été engagé sur ce projet.",
    };
  }

  return { allowed: true, reason: null };
}

function computeCurrentStep(steps) {
  if (steps.simulation?.status !== 'completed') return 'simulation';
  if (steps.visite?.status !== 'completed') return 'visite';
  if (steps.achat?.status !== 'completed') return 'achat';
  return 'achat';
}

function computeProjectStatus(steps, currentStatus) {
  if (currentStatus === 'cancelled') return 'cancelled';
  if (
    steps.simulation?.status === 'completed' &&
    steps.visite?.status === 'completed' &&
    steps.achat?.status === 'completed'
  ) {
    return 'completed';
  }
  return 'in_progress';
}

function buildProjectTitle(terrain) {
  return terrain?.title
    ? `Projet d'achat · ${terrain.title}`
    : "Projet d'achat terrain avec Ikadou";
}

async function listProjectVisits({ clientId, terrainId }) {
  if (!terrainId) return [];

  const result = await query(
    `
      SELECT
        v.id,
        v.terrain_id,
        v.client_id,
        v.visit_date,
        v.visit_time,
        v.status,
        v.notes,
        v.created_at,
        v.updated_at
      FROM visits v
      WHERE v.client_id = $1
        AND v.terrain_id = $2
      ORDER BY v.updated_at DESC, v.created_at DESC
    `,
    [clientId, terrainId]
  );

  return result.rows;
}

async function listProjectPayments({ clientId, terrainId }) {
  if (!terrainId) return [];

  const result = await query(
    `
      SELECT
        p.id,
        p.client_id,
        p.terrain_id,
        p.amount,
        p.currency,
        p.status,
        p.provider,
        p.method_type,
        p.installment_num,
        p.installment_total,
        p.reference_code,
        p.proof_status,
        p.notes,
        p.created_at,
        p.updated_at
      FROM payments p
      WHERE p.client_id = $1
        AND p.terrain_id = $2
      ORDER BY p.updated_at DESC, p.created_at DESC
    `,
    [clientId, terrainId]
  );

  return result.rows;
}

function pickVisitState(visits) {
  if (!visits.length) {
    return {
      latest_visit: null,
      visit_completed: false,
      visit_in_progress: false,
    };
  }

  const latest = visits[0];

  return {
    latest_visit: latest,
    visit_completed: VISIT_DONE_STATUSES.includes(latest.status),
    visit_in_progress: VISIT_ACTIVE_STATUSES.includes(latest.status),
  };
}

function pickPaymentState(payments) {
  if (!payments.length) {
    return {
      latest_payment: null,
      reservation_payment: null,
      payment_completed: false,
      payment_in_progress: false,
      payment_failed: false,
    };
  }

  const latest = payments[0];

  const reservationPayment =
    payments.find((p) => {
      const note = String(p.notes || '').toLowerCase();
      const ref = String(p.reference_code || '').toLowerCase();
      return (
        note.includes('reservation') ||
        ref.includes('reservation') ||
        Number(p.installment_num || 0) === 1
      );
    }) || latest;

  return {
    latest_payment: latest,
    reservation_payment: reservationPayment,
    payment_completed: PAYMENT_DONE_STATUSES.includes(latest.status),
    payment_in_progress: ACTIVE_PAYMENT_LOCK_STATUSES.includes(latest.status),
    payment_failed: PAYMENT_FAILED_STATUSES.includes(latest.status),
  };
}

async function syncProjectState(project) {
  const steps = { ...project.steps };
  const visits = await listProjectVisits({
    clientId: project.client_id,
    terrainId: project.terrain_id,
  });
  const payments = await listProjectPayments({
    clientId: project.client_id,
    terrainId: project.terrain_id,
  });

  const visitState = pickVisitState(visits);
  const paymentState = pickPaymentState(payments);

  if (steps.simulation?.status !== 'completed' && steps.simulation?.status !== 'in_progress') {
    steps.simulation = {
      ...steps.simulation,
      status: 'in_progress',
      started_at: steps.simulation?.started_at || nowIso(),
    };
  }

  if (visitState.visit_completed) {
    steps.visite = {
      ...steps.visite,
      status: 'completed',
      started_at: steps.visite?.started_at || visitState.latest_visit?.created_at || nowIso(),
      completed_at: visitState.latest_visit?.updated_at || nowIso(),
      data: {
        ...(steps.visite?.data || {}),
        latest_visit_id: visitState.latest_visit?.id || null,
        latest_visit_status: visitState.latest_visit?.status || null,
        visit_date: visitState.latest_visit?.visit_date || null,
        visit_time: visitState.latest_visit?.visit_time || null,
      },
    };
  } else if (visitState.visit_in_progress) {
    steps.visite = {
      ...steps.visite,
      status: 'in_progress',
      started_at: steps.visite?.started_at || visitState.latest_visit?.created_at || nowIso(),
      data: {
        ...(steps.visite?.data || {}),
        latest_visit_id: visitState.latest_visit?.id || null,
        latest_visit_status: visitState.latest_visit?.status || null,
        visit_date: visitState.latest_visit?.visit_date || null,
        visit_time: visitState.latest_visit?.visit_time || null,
      },
    };
  }

  if (paymentState.payment_completed) {
    steps.achat = {
      ...steps.achat,
      status: 'completed',
      started_at: steps.achat?.started_at || paymentState.latest_payment?.created_at || nowIso(),
      completed_at: paymentState.latest_payment?.updated_at || nowIso(),
      data: {
        ...(steps.achat?.data || {}),
        latest_payment_id: paymentState.latest_payment?.id || null,
        latest_payment_status: paymentState.latest_payment?.status || null,
        amount: paymentState.latest_payment?.amount || null,
        currency: paymentState.latest_payment?.currency || 'XOF',
        proof_status: paymentState.latest_payment?.proof_status || null,
      },
    };
  } else if (paymentState.payment_in_progress || paymentState.payment_failed) {
    steps.achat = {
      ...steps.achat,
      status: 'in_progress',
      started_at: steps.achat?.started_at || paymentState.latest_payment?.created_at || nowIso(),
      data: {
        ...(steps.achat?.data || {}),
        latest_payment_id: paymentState.latest_payment?.id || null,
        latest_payment_status: paymentState.latest_payment?.status || null,
        amount: paymentState.latest_payment?.amount || null,
        currency: paymentState.latest_payment?.currency || 'XOF',
        proof_status: paymentState.latest_payment?.proof_status || null,
      },
    };
  }

  const currentStep = computeCurrentStep(steps);
  const status = computeProjectStatus(steps, project.status);

  const syncedProject = {
    ...project,
    steps,
    current_step: currentStep,
    status,
    sync: {
      visits,
      payments,
      latest_visit: visitState.latest_visit,
      latest_payment: paymentState.latest_payment,
      reservation_payment: paymentState.reservation_payment,
      can_cancel: canCancelProject(project, paymentState),
    },
  };

  return syncedProject;
}

async function persistProjectState(projectId, nextProject) {
  await query(
    `
      UPDATE client_projects
      SET
        terrain_id = $2,
        title = $3,
        status = $4,
        current_step = $5,
        steps = $6::jsonb,
        metadata = $7::jsonb,
        updated_at = NOW(),
        cancel_reason = $8,
        cancelled_at = $9
      WHERE id = $1
    `,
    [
      projectId,
      nextProject.terrain_id || null,
      nextProject.title,
      nextProject.status,
      nextProject.current_step,
      JSON.stringify(nextProject.steps || buildInitialSteps()),
      JSON.stringify(nextProject.metadata || {}),
      nextProject.cancel_reason || null,
      nextProject.cancelled_at || null,
    ]
  );
}

router.get(
  '/',
  [
    q('status').optional().isIn(['in_progress', 'completed', 'cancelled']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const params = [clientId];
      let where = `WHERE cp.client_id = $1`;

      if (req.query.status) {
        params.push(req.query.status);
        where += ` AND cp.status = $${params.length}`;
      }

      const result = await query(
        `
          SELECT
            cp.id,
            cp.client_id,
            cp.terrain_id,
            cp.title,
            cp.status,
            cp.current_step,
            cp.steps,
            cp.metadata,
            cp.cancel_reason,
            cp.cancelled_at,
            cp.created_at,
            cp.updated_at,
            t.title AS terrain_title,
            t.ref AS terrain_ref,
            t.location AS terrain_location,
            t.price AS terrain_price,
            t.currency AS terrain_currency
          FROM client_projects cp
          LEFT JOIN terrains t ON t.id = cp.terrain_id
          ${where}
          ORDER BY cp.updated_at DESC, cp.created_at DESC
        `,
        params
      );

      const normalized = result.rows.map(normalizeProject);

      const syncedProjects = await Promise.all(
        normalized.map(async (project) => {
          const synced = await syncProjectState(project);
          await persistProjectState(project.id, synced);
          return buildProjectListItem(synced);
        })
      );

      const sorted = [...syncedProjects].sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
        const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
        return bTime - aTime;
      });

      return res.json({
        success: true,
        data: sorted,
        meta: {
          total: sorted.length,
          active: sorted.find((p) => p.status === 'in_progress')?.id || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  '/',
  [
    body('terrainId').optional().isUUID().withMessage('terrainId invalide'),
    body('title').optional().isString().trim(),
    body('source').optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      let terrain = null;

      if (req.body.terrainId) {
        terrain = await getTerrainOrThrow(req.body.terrainId);

        if (terrain.status !== 'published' && terrain.status !== 'reserved') {
          throw HttpError.badRequest(
            "Ce terrain n'est pas encore disponible pour démarrer un projet client"
          );
        }
      }

      const steps = buildInitialSteps();
      const metadata = {
        source: req.body.source || 'mobile_app',
      };

      const result = await query(
        `
          INSERT INTO client_projects
            (client_id, terrain_id, title, status, current_step, steps, metadata)
          VALUES ($1, $2, $3, 'in_progress', 'simulation', $4::jsonb, $5::jsonb)
          RETURNING id
        `,
        [
          clientId,
          terrain?.id || null,
          req.body.title || buildProjectTitle(terrain),
          JSON.stringify(steps),
          JSON.stringify(metadata),
        ]
      );

      const project = await getProjectOrThrow(result.rows[0].id, clientId);

      return res.status(201).json({
        success: true,
        message: terrain
          ? 'Projet créé avec le terrain sélectionné'
          : 'Projet créé. Vous pouvez commencer par la simulation puis ajouter un terrain ensuite.',
        data: buildProjectListItem(project),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:projectId',
  [param('projectId').isUUID().withMessage('projectId invalide')],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      const synced = await syncProjectState(project);

      await persistProjectState(project.id, synced);

      return res.json({
  success: true,
  data: buildProjectListItem(synced),
});
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:projectId/terrain',
  [
    param('projectId').isUUID().withMessage('projectId invalide'),
    body('terrainId').isUUID().withMessage('terrainId invalide'),
    body('mode').optional().isIn(['attach', 'replace']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      assertProjectNotClosed(project);

      const terrain = await getTerrainOrThrow(req.body.terrainId);

      if (terrain.status !== 'published' && terrain.status !== 'reserved') {
        throw HttpError.badRequest(
          "Le terrain sélectionné n'est pas disponible pour être ajouté à ce projet"
        );
      }

      const mode = req.body.mode || 'replace';

      if (
        project.terrain_id &&
        project.terrain_id !== terrain.id &&
        mode !== 'replace'
      ) {
        throw HttpError.badRequest(
          "Un terrain est déjà lié à ce projet. Utilisez le mode 'replace' pour le remplacer."
        );
      }

      const synced = await syncProjectState(project);
      const cancelCheck = canCancelProject(synced, synced.sync);

      if (!cancelCheck.allowed && project.terrain_id && project.terrain_id !== terrain.id) {
        throw HttpError.badRequest(
          "Le terrain du projet ne peut plus être remplacé car une réservation ou un paiement est déjà engagé."
        );
      }

      const nextProject = {
        ...synced,
        terrain_id: terrain.id,
        terrain_title: terrain.title,
        terrain_ref: terrain.ref,
        terrain_location: terrain.location,
        terrain_price: terrain.price,
        terrain_currency: terrain.currency,
        title: buildProjectTitle(terrain),
        metadata: {
          ...(synced.metadata || {}),
          terrain_attached_at: nowIso(),
        },
      };

      await persistProjectState(project.id, nextProject);

      const updated = await getProjectOrThrow(project.id, clientId);

      return res.json({
        success: true,
        message: project.terrain_id && project.terrain_id !== terrain.id
          ? 'Le terrain du projet a été remplacé avec succès'
          : 'Le terrain a été ajouté au projet',
        data: buildProjectListItem(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:projectId/simulation',
  [
    param('projectId').isUUID().withMessage('projectId invalide'),
    body('price').isNumeric().withMessage('Le prix simulé est invalide'),
    body('apport').optional().isNumeric().withMessage("L'apport est invalide"),
    body('rate').isIn([3, 5]).withMessage('Le taux doit être 3 ou 5'),
    body('durationMonths').isInt({ min: 1 }).withMessage('La durée est invalide'),
    body('monthlyPayment').optional().isNumeric(),
    body('totalCost').optional().isNumeric(),
    body('totalInterests').optional().isNumeric(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      assertProjectNotClosed(project);

      const now = nowIso();
      const steps = { ...project.steps };

      steps.simulation = {
        ...steps.simulation,
        status: 'completed',
        started_at: steps.simulation?.started_at || now,
        completed_at: now,
        data: {
          price: Number(req.body.price),
          apport: Number(req.body.apport || 0),
          rate: Number(req.body.rate),
          durationMonths: Number(req.body.durationMonths),
          frequency: 'monthly',
          monthlyPayment: req.body.monthlyPayment != null ? Number(req.body.monthlyPayment) : null,
          totalCost: req.body.totalCost != null ? Number(req.body.totalCost) : null,
          totalInterests: req.body.totalInterests != null ? Number(req.body.totalInterests) : null,
        },
      };

      if (steps.visite?.status === 'pending') {
        steps.visite = {
          ...steps.visite,
          status: 'in_progress',
          started_at: steps.visite?.started_at || now,
        };
      }

      const nextProject = {
        ...project,
        steps,
        current_step: computeCurrentStep(steps),
        status: computeProjectStatus(steps, project.status),
        metadata: {
          ...(project.metadata || {}),
          last_simulation_at: now,
        },
      };

      await persistProjectState(project.id, nextProject);

      const updated = await getProjectOrThrow(project.id, clientId);

      return res.json({
        success: true,
        message:
          'Simulation enregistrée. Votre projet avance maintenant vers l’étape de visite.',
        data: buildProjectListItem(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:projectId/visite/start',
  [param('projectId').isUUID().withMessage('projectId invalide')],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      assertProjectNotClosed(project);

      const now = nowIso();
      const steps = { ...project.steps };

      if (steps.simulation?.status !== 'completed') {
        throw HttpError.badRequest(
          "La visite ne peut pas être démarrée tant que la simulation n'est pas validée."
        );
      }

      steps.visite = {
        ...steps.visite,
        status: steps.visite?.status === 'completed' ? 'completed' : 'in_progress',
        started_at: steps.visite?.started_at || now,
      };

      const nextProject = {
        ...project,
        steps,
        current_step: computeCurrentStep(steps),
        status: computeProjectStatus(steps, project.status),
      };

      await persistProjectState(project.id, nextProject);

      const updated = await getProjectOrThrow(project.id, clientId);

      return res.json({
        success: true,
        message: 'L’étape visite est maintenant en cours sur ce projet.',
        data: buildProjectListItem(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:projectId/sync',
  [param('projectId').isUUID().withMessage('projectId invalide')],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      const synced = await syncProjectState(project);

      await persistProjectState(project.id, synced);

      return res.json({
  success: true,
  message:
    'Le projet a été synchronisé avec les dernières informations de visite et de paiement.',
  data: buildProjectListItem(synced),
});
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:projectId/cancel',
  [
    param('projectId').isUUID().withMessage('projectId invalide'),
    body('reason').optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const project = await getProjectOrThrow(req.params.projectId, clientId);
      const synced = await syncProjectState(project);

      const cancelCheck = canCancelProject(synced, synced.sync);
      if (!cancelCheck.allowed) {
        throw HttpError.badRequest(cancelCheck.reason);
      }

      const nextProject = {
        ...synced,
        status: 'cancelled',
        current_step: computeCurrentStep(synced.steps),
        cancel_reason: req.body.reason || null,
        cancelled_at: nowIso(),
      };

      await persistProjectState(project.id, nextProject);

      const updated = await getProjectOrThrow(project.id, clientId);

      return res.json({
        success: true,
        message: 'Le projet a bien été annulé.',
        data: buildProjectListItem(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;