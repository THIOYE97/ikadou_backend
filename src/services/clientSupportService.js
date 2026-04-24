const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const NotificationService = require('./notificationService');
const { addSupportAttachment, listTicketAttachments } = require('./supportAttachmentService');

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function getClientTicketOrThrow(ticketId, clientId) {
  const result = await query(
    `SELECT *
     FROM support_tickets
     WHERE id = $1
       AND client_id = $2`,
    [ticketId, clientId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Ticket introuvable');
  }

  return result.rows[0];
}

async function listClientTickets({ clientId, status, page = 1, limit = 20 }) {
  const safePage = parsePositiveInt(page, 1);
  const safeLimit = parsePositiveInt(limit, 20);
  const offset = (safePage - 1) * safeLimit;

  const params = [clientId];
  const conditions = [`t.client_id = $1`];

  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM support_tickets t
     ${where}`,
    params
  );

  params.push(safeLimit, offset);

  const rows = await query(
    `SELECT
       t.id,
       t.ref,
       t.subject,
       t.description,
       t.priority,
       t.status,
       t.category,
       t.source,
       t.channel,
       t.created_at,
       t.updated_at,
       t.last_message_at,
       t.unread_count_client,
       t.unread_count_support,
       u.first_name || ' ' || u.last_name AS assigned_name
     FROM support_tickets t
     LEFT JOIN internal_users u ON t.assigned_to = u.id
     ${where}
     ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );

  const total = countRes.rows[0]?.total || 0;

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

async function createClientTicket({
  clientId,
  subject,
  description,
  category = 'other',
  priority = 'medium',
}) {
  return transaction(async (db) => {
    const ticketRes = await db.query(
      `INSERT INTO support_tickets
        (subject, description, priority, client_id, source, channel, category, created_by, last_message_at)
       VALUES ($1, $2, $3, $4, 'mobile_app', 'support_chat', $5, NULL, NOW())
       RETURNING *`,
      [subject, description || null, priority, clientId, category]
    );

    const ticket = ticketRes.rows[0];

    await db.query(
      `INSERT INTO ticket_history
        (ticket_id, action, new_value, comment, user_id)
       VALUES ($1, 'created', $2, 'Ticket créé depuis l’app client', NULL)`,
      [
        ticket.id,
        JSON.stringify({
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
        }),
      ]
    );

    await db.query(
  `INSERT INTO ticket_messages
    (ticket_id, content, author_id, is_internal, sender_type, client_id, is_read_by_client, is_read_by_support)
   VALUES ($1, $2, NULL, FALSE, 'client', $3, TRUE, FALSE)`,
  [ticket.id, description || subject, clientId]
);

    await db.query(
      `UPDATE support_tickets
       SET unread_count_support = 1,
           unread_count_client = 0
       WHERE id = $1`,
      [ticket.id]
    );

    try {
      const clientRes = await db.query(`SELECT * FROM clients WHERE id = $1`, [clientId]);
      if (clientRes.rows.length) {
        await NotificationService.notifyTicketOpened({
          client: clientRes.rows[0],
          ticket,
          sentBy: null,
        });
      }
    } catch (_) {}

    return ticket;
  });
}

async function getClientTicketDetail(ticketId, clientId) {
  await getClientTicketOrThrow(ticketId, clientId);

  const [ticketRes, messagesRes, historyRes] = await Promise.all([
    query(
      `SELECT
         t.*,
         u.first_name || ' ' || u.last_name AS assigned_name
       FROM support_tickets t
       LEFT JOIN internal_users u ON t.assigned_to = u.id
       WHERE t.id = $1
         AND t.client_id = $2`,
      [ticketId, clientId]
    ),
    query(
      `SELECT
         tm.*,
         tm.content AS message,
         CASE
           WHEN tm.sender_type = 'client' THEN 'Vous'
           WHEN tm.sender_type = 'internal_user' THEN iu.first_name || ' ' || iu.last_name
           ELSE 'Système'
         END AS author_name
       FROM ticket_messages tm
       LEFT JOIN internal_users iu ON tm.author_id = iu.id
       WHERE tm.ticket_id = $1
         AND (tm.is_internal = FALSE OR tm.is_internal IS NULL)
       ORDER BY tm.created_at ASC`,
      [ticketId]
    ),
    query(
      `SELECT
         th.*,
         iu.first_name || ' ' || iu.last_name AS author
       FROM ticket_history th
       LEFT JOIN internal_users iu ON th.user_id = iu.id
       WHERE th.ticket_id = $1
       ORDER BY th.created_at DESC`,
      [ticketId]
    ),
  ]);

 let attachments = [];
try {
  attachments = await listTicketAttachments(ticketId);
} catch (err) {
  console.warn('ticket_attachments read skipped:', err.message);
}

  await query(
    `UPDATE support_tickets
     SET unread_count_client = 0
     WHERE id = $1
       AND client_id = $2`,
    [ticketId, clientId]
  );

  return {
    ...ticketRes.rows[0],
    messages: messagesRes.rows,
    attachments,
    history: historyRes.rows,
  };
}
async function addClientTicketMessage({
  ticketId,
  clientId,
  message,
}) {
  await getClientTicketOrThrow(ticketId, clientId);

  return transaction(async (db) => {
    const result = await db.query(
  `INSERT INTO ticket_messages
    (ticket_id, content, author_id, is_internal, sender_type, client_id, is_read_by_client, is_read_by_support)
   VALUES ($1, $2, NULL, FALSE, 'client', $3, TRUE, FALSE)
   RETURNING *`,
  [ticketId, message, clientId]
);

    await db.query(
      `UPDATE support_tickets
       SET last_message_at = NOW(),
           unread_count_support = unread_count_support + 1,
           status = CASE WHEN status = 'waiting_client' THEN 'in_progress' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [ticketId]
    );

    await db.query(
      `INSERT INTO ticket_history
        (ticket_id, action, comment, user_id)
       VALUES ($1, 'message_added', 'Message client ajouté', NULL)`,
      [ticketId]
    );

    return result.rows[0];
  });
}

async function addClientTicketAttachment({
  ticketId,
  clientId,
  messageId = null,
  fileUrl,
  fileStorageKey,
  fileType = null,
  sizeBytes = null,
}) {
  await getClientTicketOrThrow(ticketId, clientId);

  return addSupportAttachment({
    ticketId,
    messageId,
    uploadedByType: 'client',
    uploadedByClientId: clientId,
    uploadedByUserId: null,
    fileUrl,
    fileStorageKey,
    fileType,
    sizeBytes,
    historyComment: 'Pièce jointe client ajoutée',
    historyUserId: null,
  });
}

module.exports = {
  listClientTickets,
  createClientTicket,
  getClientTicketDetail,
  addClientTicketMessage,
  addClientTicketAttachment,
};