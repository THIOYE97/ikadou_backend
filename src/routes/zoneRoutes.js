const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query } = require('../data/db');

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

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT z.*, COUNT(DISTINCT t.id) AS terrain_count, COUNT(DISTINCT a.id) AS agent_count
       FROM zones z
       LEFT JOIN terrains t ON t.zone_id = z.id
       LEFT JOIN agents a ON a.zone_id = z.id
       WHERE z.is_active = TRUE
       GROUP BY z.id
       ORDER BY z.region, z.name`
    );
    return res.json({ success: true, data: rows.rows });
  } catch (error) { next(error); }
});

router.post(
  '/',
  requireRole('admin', 'super_admin'),
  [body('name').trim().notEmpty(), body('region').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { name, region, description } = req.body;
      const result = await query(
        `INSERT INTO zones (name, region, description) VALUES ($1,$2,$3) RETURNING *`,
        [name, region || null, description || null]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);

router.patch('/:id', requireRole('admin', 'super_admin'), validate, async (req, res, next) => {
  try {
    const { name, region, description, isActive } = req.body;
    const fields = []; const params = [];
    if (name !== undefined)      { params.push(name);      fields.push(`name = $${params.length}`); }
    if (region !== undefined)    { params.push(region);    fields.push(`region = $${params.length}`); }
    if (description !== undefined) { params.push(description); fields.push(`description = $${params.length}`); }
    if (isActive !== undefined)  { params.push(isActive);  fields.push(`is_active = $${params.length}`); }
    if (!fields.length) throw HttpError.badRequest('Aucun champ');
    params.push(req.params.id);
    const result = await query(
      `UPDATE zones SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!result.rows.length) throw HttpError.notFound('Zone introuvable');
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;