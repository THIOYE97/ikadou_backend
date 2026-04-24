const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const NotificationService = require('./notificationService');
const { listTicketAttachments, addSupportAttachment } = require('./supportAttachmentService');

const TICKET_STATUS_TRANSITIONS = {
  open: ['in_progress', 'waiting_client', 'resolved', 'closed'],
  in_progress: ['waiting_client', 'resolved', 'closed'],
  waiting_client: ['in_progress', 'resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

async function getTicketOrThrow(ticketId) {
  const result = await query(
    `SELECT *
     FROM support_tickets
     WHERE id = $1`,
    [ticketId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Ticket introuvable');
  }

  return result.rows[0];
}

async function appendTicketHistory({
  ticketId,
  action,
  oldValue = null,
  newValue = null,
  comment = null,
  userId = null,
}) {
  await query(
    `INSERT INTO ticket_history (ticket_id, action, old_value, new_value, comment, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ticketId,
      action,
      oldValue,
      newValue,
      comment,
      userId,
    ]
  );
}

async function listTickets({
  search,
  status,
  priority,
  assigned_to,
  page = 1,
  limit = 20,
}) {
  const params = [];
  const conditions = [];

  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conditions.push(`(t.ref ILIKE $${n} OR t.subject ILIKE $${n})`);
  }

  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }

  if (priority) {
    params.push(priority);
    conditions.push(`t.priority = $${params.length}`);
  }

  if (assigned_to) {
    params.push(assigned_to);
    conditions.push(`t.assigned_to = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await query(
    `SELECT COUNT(*) FROM support_tickets t ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(safeLimit, offset);
  const rows = await query(
    `SELECT
       t.id, t.ref, t.subject, t.priority, t.status,
       t.created_at, t.updated_at, t.resolved_at,
       c.first_name || ' ' || c.last_name AS client_name, t.client_id,
       u.first_name || ' ' || u.last_name AS assigned_name, t.assigned_to
     FROM support_tickets t
     LEFT JOIN clients c ON t.client_id = c.id
     LEFT JOIN internal_users u ON t.assigned_to = u.id
     ${where}
     ORDER BY
       CASE t.priority
         WHEN 'urgent' THEN 1
         WHEN 'high' THEN 2
         WHEN 'medium' THEN 3
         ELSE 4
       END,
       t.created_at DESC
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

async function createTicket({
  subject,
  description = null,
  priority,
  clientId = null,
  assignedTo = null,
  userId,
}) {
  const result = await query(
    `INSERT INTO support_tickets
       (subject, description, priority, client_id, assigned_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [subject, description, priority, clientId, assignedTo, userId]
  );

  const ticket = result.rows[0];

  await appendTicketHistory({
    ticketId: ticket.id,
    action: 'created',
    newValue: JSON.stringify({ priority, status: 'open' }),
    userId,
  });

  if (clientId) {
    try {
      const clientRes = await query(
        `SELECT * FROM clients WHERE id = $1`,
        [clientId]
      );

      if (clientRes.rows.length) {
        await NotificationService.notifyTicketOpened({
          client: clientRes.rows[0],
          ticket,
          sentBy: userId,
        });
      }
    } catch (_) {}
  }

  return ticket;
}

async function getAssignableSupportUsers() {
  const result = await query(
    `SELECT
       id,
       first_name,
       last_name,
       email,
       role,
       status
     FROM internal_users
     WHERE role = 'support'
       AND status = 'active'
     ORDER BY first_name ASC, last_name ASC`
  );

  return result.rows;
}

async function getTicketDetail(ticketId) {
  const result = await query(
    `SELECT
       t.*,
       c.first_name || ' ' || c.last_name AS client_name,
       c.email AS client_email,
       c.phone AS client_phone,
       u.first_name || ' ' || u.last_name AS assigned_name
     FROM support_tickets t
     LEFT JOIN clients c ON t.client_id = c.id
     LEFT JOIN internal_users u ON t.assigned_to = u.id
     WHERE t.id = $1`,
    [ticketId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Ticket introuvable');
  }

  const [messages, history, attachments] = await Promise.all([
    query(
      `SELECT
         tm.*,
         tm.content AS message,
         CASE
           WHEN tm.sender_type = 'client' THEN COALESCE(c.first_name || ' ' || c.last_name, 'Client')
           WHEN tm.sender_type = 'internal_user' THEN COALESCE(iu.first_name || ' ' || iu.last_name, 'Agent support')
           ELSE 'Système'
         END AS author_name,
         COALESCE(iu.first_name || ' ' || iu.last_name, c.first_name || ' ' || c.last_name, 'Utilisateur') AS author
       FROM ticket_messages tm
       LEFT JOIN internal_users iu ON tm.author_id = iu.id
       LEFT JOIN clients c ON tm.client_id = c.id
       WHERE tm.ticket_id = $1
       ORDER BY tm.created_at ASC`,
      [ticketId]
    ),
    query(
      `SELECT th.*, u.first_name || ' ' || u.last_name AS author
       FROM ticket_history th
       LEFT JOIN internal_users u ON th.user_id = u.id
       WHERE th.ticket_id = $1
       ORDER BY th.created_at DESC`,
      [ticketId]
    ),
    listTicketAttachments(ticketId),
  ]);

  return {
    ...result.rows[0],
    messages: messages.rows,
    attachments,
    history: history.rows,
  };
}

async function changeTicketStatus({
  ticketId,
  status,
  comment = null,
  userId,
}) {
  const existing = await getTicketOrThrow(ticketId);
  const allowed = TICKET_STATUS_TRANSITIONS[existing.status] || [];

  if (!allowed.includes(status)) {
    throw HttpError.badRequest(`Transition invalide: ${existing.status} -> ${status}`);
  }

  const resolvedAt = status === 'resolved' ? new Date() : null;

  await transaction(async (client) => {
    await client.query(
      `UPDATE support_tickets
       SET status = $1,
           resolved_at = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [status, resolvedAt, ticketId]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, action, old_value, new_value, comment, user_id)
       VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
      [
        ticketId,
        existing.status,
        status,
        comment || null,
        userId,
      ]
    );
  });

  const updated = await getTicketOrThrow(ticketId);

  if (existing.client_id && existing.status !== status) {
    try {
      const clientRes = await query(
        `SELECT id, first_name, last_name, email, phone, push_token
         FROM clients
         WHERE id = $1`,
        [existing.client_id]
      );

      if (clientRes.rows.length) {
        const statusLabels = {
          open: 'Ouvert',
          in_progress: 'En cours de traitement',
          waiting_client: 'En attente de votre retour',
          resolved: 'Résolu',
          closed: 'Fermé',
        };

        await NotificationService.notifySupportStatusChanged({
          client: clientRes.rows[0],
          ticket: updated,
          statusLabel: statusLabels[status] || status,
          sentBy: userId,
        });
      }
    } catch (_) {}
  }

  return updated;
}
async function assignTicket({
  ticketId,
  assignedTo,
  userId,
}) {
  const existing = await getTicketOrThrow(ticketId);

  const supportUser = await query(
    `SELECT id, first_name, last_name
     FROM internal_users
     WHERE id = $1
       AND role = 'support'
       AND status = 'active'`,
    [assignedTo]
  );

  if (!supportUser.rows.length) {
    throw HttpError.notFound('Utilisateur support introuvable ou inactif');
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE support_tickets
       SET assigned_to = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [assignedTo, ticketId]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, action, old_value, new_value, comment, user_id)
       VALUES ($1, 'assigned', $2, $3, $4, $5)`,
      [
        ticketId,
        existing.assigned_to,
        assignedTo,
        'Assignation support',
        userId,
      ]
    );
  });

  return getTicketOrThrow(ticketId);
}

async function addTicketMessage({
  ticketId,
  message,
  userId,
  isInternal = false,
}) {
  const ticket = await getTicketOrThrow(ticketId);

  const result = await query(
    `INSERT INTO ticket_messages
      (ticket_id, content, author_id, is_internal, sender_type, client_id, is_read_by_client, is_read_by_support)
     VALUES ($1, $2, $3, $4, 'internal_user', NULL, $5, TRUE)
     RETURNING *`,
    [ticketId, message, userId, isInternal, isInternal]
  );

  await query(
    `UPDATE support_tickets
     SET last_message_at = NOW(),
         unread_count_client = CASE WHEN $2 = TRUE THEN unread_count_client ELSE unread_count_client + 1 END,
         unread_count_support = 0,
         status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
         updated_at = NOW()
     WHERE id = $1`,
    [ticketId, isInternal]
  );

  await appendTicketHistory({
    ticketId,
    action: 'message_added',
    comment: isInternal ? 'Note interne ajoutée' : 'Message agent ajouté',
    userId,
  });

  if (!isInternal && ticket.client_id) {
    try {
      const clientRes = await query(
        `SELECT id, first_name, last_name, email, phone, push_token
         FROM clients
         WHERE id = $1`,
        [ticket.client_id]
      );

      if (clientRes.rows.length) {
        await NotificationService.notifySupportReply({
          client: clientRes.rows[0],
          ticket,
          message,
          sentBy: userId,
        });
      }
    } catch (_) {}
  }

  return result.rows[0];
}

async function addTicketAttachment({
  ticketId,
  userId,
  messageId = null,
  fileUrl,
  fileStorageKey,
  fileType = null,
  sizeBytes = null,
}) {
  await getTicketOrThrow(ticketId);

  return addSupportAttachment({
    ticketId,
    messageId,
    uploadedByType: 'internal_user',
    uploadedByUserId: userId,
    uploadedByClientId: null,
    fileUrl,
    fileStorageKey,
    fileType,
    sizeBytes,
    historyComment: 'Pièce jointe agent ajoutée',
    historyUserId: userId,
  });
}

module.exports = {
  TICKET_STATUS_TRANSITIONS,
  listTickets,
  createTicket,
  getAssignableSupportUsers,
  getTicketDetail,
  changeTicketStatus,
  assignTicket,
  addTicketMessage,
  addTicketAttachment,
};