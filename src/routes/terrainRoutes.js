const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query, transaction } = require('../data/db');

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

// Valid status transitions
const STATUS_TRANSITIONS = {
  draft:       ['published', 'unavailable'],
  published:   ['reserved', 'unavailable', 'draft'],
  reserved:    ['published', 'sold', 'unavailable'],
  sold:        [],
  unavailable: ['draft', 'published'],
};

// Roles that can make sensitive transitions (reserved -> sold, etc.)
const SENSITIVE_TRANSITIONS = ['sold'];

router.use(requireAuth);

// ─── GET /terrains ────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const {
      search, status, availability, zone_id, is_featured,
      page = 1, limit = 20, sort = 'created_at', order = 'desc',
    } = req.query;

    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(t.title ILIKE $${n} OR t.ref ILIKE $${n} OR t.location ILIKE $${n})`);
    }
    if (status)       { params.push(status);       conditions.push(`t.status = $${params.length}`); }
    if (availability) { params.push(availability); conditions.push(`t.availability = $${params.length}`); }
    if (zone_id)      { params.push(zone_id);      conditions.push(`t.zone_id = $${params.length}`); }
    if (is_featured === 'true') { conditions.push(`t.is_featured = TRUE`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = ['created_at', 'price', 'surface_m2', 'title', 'ref'];
    const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM terrains t ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         t.id, t.ref, t.title, t.price, t.currency, t.surface_m2,
         t.location, t.status, t.availability, t.is_featured,
         t.created_at, t.updated_at,
         z.name AS zone_name
       FROM terrains t
       LEFT JOIN zones z ON t.zone_id = z.id
       ${where}
       ORDER BY t.${sortCol} ${sortOrder}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: rows.rows,
      meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

// ─── POST /terrains ───────────────────────────────────────

router.post(
  '/',
  [
    body('ref').trim().notEmpty().withMessage('Référence requise'),
    body('title').trim().notEmpty().withMessage('Titre requis'),
    body('price').isNumeric().withMessage('Prix requis'),
    body('status').optional().isIn(['draft','published','reserved','sold','unavailable']),
    body('currency').optional().isIn(['XOF','EUR','USD']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        ref, title, description, price, currency = 'XOF',
        surfaceM2, location, zoneId, latitude, longitude,
        status = 'draft', isFeatured = false, amenities = [], images = [],
      } = req.body;

      // Check ref uniqueness
      const existing = await query(`SELECT id FROM terrains WHERE ref = $1`, [ref]);
      if (existing.rows.length) throw HttpError.conflict(`La référence "${ref}" est déjà utilisée`);

      const result = await query(
        `INSERT INTO terrains
           (ref, title, description, price, currency, surface_m2, location, zone_id,
            latitude, longitude, status, is_featured, amenities, images, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          ref, title, description || null, price, currency,
          surfaceM2 || null, location || null, zoneId || null,
          latitude || null, longitude || null, status, isFeatured,
          JSON.stringify(amenities), JSON.stringify(images), req.user.id,
        ]
      );

      const terrain = result.rows[0];

      await query(
        `INSERT INTO terrain_history (terrain_id, field, new_value, user_id)
         VALUES ($1, 'created', $2, $3)`,
        [terrain.id, JSON.stringify({ ref, title, status }), req.user.id]
      );

      return res.status(201).json({ success: true, data: terrain });
    } catch (error) { next(error); }
  }
);

// ─── GET /terrains/:id ────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.*, z.name AS zone_name, z.region AS zone_region
       FROM terrains t
       LEFT JOIN zones z ON t.zone_id = z.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Terrain introuvable');

    const history = await query(
      `SELECT th.*, u.first_name || ' ' || u.last_name AS author
       FROM terrain_history th
       LEFT JOIN internal_users u ON th.user_id = u.id
       WHERE th.terrain_id = $1
       ORDER BY th.created_at DESC`,
      [req.params.id]
    );

    const docs = await query(
      `SELECT id, name, type, created_at FROM documents WHERE related_type = 'terrain' AND related_id = $1`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: { ...result.rows[0], history: history.rows, documents: docs.rows },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /terrains/:id ──────────────────────────────────

router.patch('/:id', validate, async (req, res, next) => {
  try {
    const {
      title, description, price, currency, surfaceM2,
      location, zoneId, latitude, longitude, isFeatured, amenities, images,
    } = req.body;

    const fields = [];
    const params = [];
    const changed = [];

    const set = (col, val) => {
      if (val !== undefined) {
        params.push(typeof val === 'object' ? JSON.stringify(val) : val);
        fields.push(`${col} = $${params.length}`);
        changed.push(col);
      }
    };

    set('title', title);
    set('description', description);
    set('price', price);
    set('currency', currency);
    set('surface_m2', surfaceM2);
    set('location', location);
    set('zone_id', zoneId);
    set('latitude', latitude);
    set('longitude', longitude);
    set('is_featured', isFeatured);
    set('amenities', amenities);
    set('images', images);

    if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

    params.push(req.params.id);
    const result = await query(
      `UPDATE terrains SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) throw HttpError.notFound('Terrain introuvable');

    // Log sensitive field changes (price)
    if (changed.includes('price')) {
      await query(
        `INSERT INTO terrain_history (terrain_id, field, new_value, comment, user_id)
         VALUES ($1, 'price', $2, 'Prix mis à jour', $3)`,
        [req.params.id, String(price), req.user.id]
      );
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── PATCH /terrains/:id/status ───────────────────────────

router.patch(
  '/:id/status',
  [
    body('status').isIn(['draft','published','reserved','sold','unavailable']),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;

      const existing = await query(`SELECT status FROM terrains WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Terrain introuvable');

      const currentStatus = existing.rows[0].status;
      const allowed = STATUS_TRANSITIONS[currentStatus] || [];

      if (!allowed.includes(status)) {
        throw HttpError.badRequest(
          `Transition "${currentStatus}" → "${status}" non autorisée. Autorisées: ${allowed.join(', ') || 'aucune'}`
        );
      }

      // Sensitive transitions require manager+
      if (SENSITIVE_TRANSITIONS.includes(status)) {
        const roleLevel = { super_admin: 7, admin: 6, manager: 5, finance: 4, sales: 3, support: 3, agent: 2 };
        if ((roleLevel[req.user.role] || 0) < 5) {
          throw HttpError.forbidden('Rôle insuffisant pour cette transition');
        }
      }

      // When sold, update availability too
      const availUpdate = status === 'sold' ? `, availability = 'sold'` : '';

      await transaction(async (client) => {
        await client.query(
          `UPDATE terrains SET status = $1 ${availUpdate} WHERE id = $2`,
          [status, req.params.id]
        );
        await client.query(
          `INSERT INTO terrain_history (terrain_id, field, old_value, new_value, comment, user_id)
           VALUES ($1, 'status', $2, $3, $4, $5)`,
          [req.params.id, currentStatus, status, comment || null, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM terrains WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

module.exports = router;