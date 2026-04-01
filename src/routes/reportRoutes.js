const express = require('express');
const router = express.Router();

const { requireAuth, requireMinRole } = require('../middleware/requireAuth');
const { query } = require('../data/db');

router.use(requireAuth);
router.use(requireMinRole('manager'));

const periodToInterval = (period) => {
  const map = { '7d': '7 days', '30d': '30 days', '3m': '90 days', '12m': '365 days' };
  return map[period] || '30 days';
};

// ─── GET /reports/overview ────────────────────────────────

router.get('/overview', async (req, res, next) => {
  try {
    const { period = '30d', zone_id, agent_id } = req.query;
    const interval = periodToInterval(period);

    const params = [];
    const leadBase = [`l.created_at >= NOW() - INTERVAL '${interval}'`];
    if (zone_id)  { params.push(zone_id);  leadBase.push(`l.terrain_id IN (SELECT id FROM terrains WHERE zone_id = $${params.length})`); }
    if (agent_id) { params.push(agent_id); leadBase.push(`l.agent_id = $${params.length}`); }
    const lw = `WHERE ${leadBase.join(' AND ')}`;

    const [
      leadsBySource, leadsByStatus,
      agentsPerf, paymentsByStatus,
      visitsByStatus, supportByStatus,
    ] = await Promise.all([
      // Leads par source
      query(
        `SELECT source, COUNT(*) AS count FROM leads l ${lw} GROUP BY source ORDER BY count DESC`,
        params
      ),
      // Leads par statut
      query(
        `SELECT status, COUNT(*) AS count FROM leads l ${lw} GROUP BY status ORDER BY count DESC`,
        params
      ),
      // Performance agents
      query(
        `SELECT
           a.first_name || ' ' || a.last_name AS agent_name,
           COUNT(DISTINCT l.id) AS leads_count,
           COUNT(DISTINCT v.id) AS visits_count,
           COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'converted') AS conversions
         FROM agents a
         LEFT JOIN leads l  ON l.agent_id = a.id  AND l.created_at  >= NOW() - INTERVAL '${interval}'
         LEFT JOIN visits v ON v.agent_id = a.id  AND v.created_at  >= NOW() - INTERVAL '${interval}'
         WHERE a.status = 'active'
         GROUP BY a.id ORDER BY leads_count DESC LIMIT 10`
      ),
      // Paiements par statut
      query(
        `SELECT status, COUNT(*) AS count, SUM(amount) AS total_amount, currency
         FROM payments
         WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY status, currency ORDER BY count DESC`
      ),
      // Visites par statut
      query(
        `SELECT status, COUNT(*) AS count FROM visits
         WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY status ORDER BY count DESC`
      ),
      // Support par statut
      query(
        `SELECT status, priority, COUNT(*) AS count FROM support_tickets
         WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY status, priority ORDER BY count DESC`
      ),
    ]);

    return res.json({
      success: true,
      data: {
        period,
        leads_by_source:    leadsBySource.rows,
        leads_by_status:    leadsByStatus.rows,
        agents_performance: agentsPerf.rows,
        payments_by_status: paymentsByStatus.rows,
        visits_by_status:   visitsByStatus.rows,
        support_by_status:  supportByStatus.rows,
      },
    });
  } catch (error) { next(error); }
});

// ─── GET /reports/leads ───────────────────────────────────

router.get('/leads', async (req, res, next) => {
  try {
    const { period = '30d', zone_id, agent_id, source } = req.query;
    const interval = periodToInterval(period);
    const params = [];
    const conditions = [`created_at >= NOW() - INTERVAL '${interval}'`];

    if (zone_id)  { params.push(zone_id);  conditions.push(`terrain_id IN (SELECT id FROM terrains WHERE zone_id = $${params.length})`); }
    if (agent_id) { params.push(agent_id); conditions.push(`agent_id = $${params.length}`); }
    if (source)   { params.push(source);   conditions.push(`source = $${params.length}`); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [bySource, byStatus, trend] = await Promise.all([
      query(`SELECT source, COUNT(*) AS count FROM leads ${where} GROUP BY source ORDER BY count DESC`, params),
      query(`SELECT status, COUNT(*) AS count FROM leads ${where} GROUP BY status ORDER BY count DESC`, params),
      // Weekly trend
      query(
        `SELECT DATE_TRUNC('week', created_at) AS week, COUNT(*) AS count
         FROM leads ${where} GROUP BY week ORDER BY week ASC`,
        params
      ),
    ]);

    return res.json({
      success: true,
      data: { period, by_source: bySource.rows, by_status: byStatus.rows, trend: trend.rows },
    });
  } catch (error) { next(error); }
});

// ─── GET /reports/payments ────────────────────────────────

router.get('/payments', requireMinRole('finance'), async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const interval = periodToInterval(period);

    const [byStatus, byPeriod, totals] = await Promise.all([
      query(
        `SELECT status, COUNT(*) AS count, SUM(amount) AS total, currency
         FROM payments WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY status, currency`
      ),
      query(
        `SELECT DATE_TRUNC('week', created_at) AS week,
                COUNT(*) AS count, SUM(amount) AS total, currency
         FROM payments WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY week, currency ORDER BY week ASC`
      ),
      query(
        `SELECT
           COUNT(*) AS total_count,
           COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
           SUM(amount) FILTER (WHERE status = 'confirmed') AS confirmed_amount,
           currency
         FROM payments WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY currency`
      ),
    ]);

    return res.json({
      success: true,
      data: { period, by_status: byStatus.rows, trend: byPeriod.rows, totals: totals.rows },
    });
  } catch (error) { next(error); }
});

// ─── GET /reports/support ─────────────────────────────────

router.get('/support', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const interval = periodToInterval(period);

    const [byStatus, byPriority, avgResolution] = await Promise.all([
      query(
        `SELECT status, COUNT(*) AS count FROM support_tickets
         WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY status`
      ),
      query(
        `SELECT priority, COUNT(*) AS count FROM support_tickets
         WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY priority ORDER BY count DESC`
      ),
      query(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) AS avg_hours_to_resolve,
           COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved_count
         FROM support_tickets
         WHERE created_at >= NOW() - INTERVAL '${interval}'`
      ),
    ]);

    return res.json({
      success: true,
      data: {
        period,
        by_status:      byStatus.rows,
        by_priority:    byPriority.rows,
        avg_resolution: avgResolution.rows[0],
      },
    });
  } catch (error) { next(error); }
});

module.exports = router;
