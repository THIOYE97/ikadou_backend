const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { query } = require('../data/db');

router.use(requireAuth);

function getDateFromPeriod(period) {
  const now = new Date();

  switch (period) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case '7d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
    case '30d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case 'month': {
      return new Date(now.getFullYear(), now.getMonth(), 1);
    }
    default: {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
  }
}

router.get('/kpis', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const fromDate = getDateFromPeriod(period);

    const [
      newLeadsRes,
      pendingLeadsRes,
      visitsPlannedRes,
      paymentsPendingRes,
      ticketsOpenRes,
      activeClientsRes,
      recentLeadsRes,
      upcomingVisitsRes,
    ] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS count
         FROM leads
         WHERE created_at >= $1`,
        [fromDate]
      ),

      query(
        `SELECT COUNT(*)::int AS count
         FROM leads
         WHERE status IN ('new', 'contacted', 'qualified', 'visit_scheduled')
           AND created_at >= $1`,
        [fromDate]
      ),

      query(
        `SELECT COUNT(*)::int AS count
         FROM visits
         WHERE status IN ('scheduled', 'confirmed')
           AND visit_date >= CURRENT_DATE`,
        []
      ),

      query(
        `SELECT COUNT(*)::int AS count
         FROM payments
         WHERE status = 'pending'
           AND created_at >= $1`,
        [fromDate]
      ),

      query(
        `SELECT COUNT(*)::int AS count
         FROM support_tickets
         WHERE status IN ('open', 'in_progress', 'waiting_client')
           AND created_at >= $1`,
        [fromDate]
      ),

      query(
        `SELECT COUNT(*)::int AS count
         FROM clients
         WHERE status = 'active'`,
        []
      ),

      query(
        `SELECT id, first_name, last_name, source, status, created_at
         FROM leads
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT 5`,
        [fromDate]
      ),

      query(
        `SELECT
           v.id,
           v.visit_date,
           v.visit_time,
           t.title AS terrain_title,
           a.first_name || ' ' || a.last_name AS agent_name
         FROM visits v
         LEFT JOIN terrains t ON t.id = v.terrain_id
         LEFT JOIN agents a ON a.id = v.agent_id
         WHERE v.status IN ('scheduled', 'confirmed')
           AND v.visit_date >= CURRENT_DATE
         ORDER BY v.visit_date ASC, v.visit_time ASC
         LIMIT 5`,
        []
      ),
    ]);

    return res.json({
      success: true,
      data: {
        new_leads: newLeadsRes.rows[0]?.count || 0,
        pending_leads: pendingLeadsRes.rows[0]?.count || 0,
        visits_planned: visitsPlannedRes.rows[0]?.count || 0,
        payments_pending: paymentsPendingRes.rows[0]?.count || 0,
        tickets_open: ticketsOpenRes.rows[0]?.count || 0,
        active_clients: activeClientsRes.rows[0]?.count || 0,
        recent_leads: recentLeadsRes.rows || [],
        upcoming_visits: upcomingVisitsRes.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;