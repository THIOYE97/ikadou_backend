const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');

async function addSupportAttachment({
  ticketId,
  messageId = null,
  uploadedByType,
  uploadedByUserId = null,
  uploadedByClientId = null,
  fileUrl,
  fileStorageKey,
  fileType = null,
  sizeBytes = null,
  historyComment = 'Pièce jointe ajoutée',
  historyUserId = null,
}) {
  if (!ticketId) {
    throw HttpError.badRequest('ticketId requis');
  }

  if (!uploadedByType || !['client', 'internal_user'].includes(uploadedByType)) {
    throw HttpError.badRequest('uploadedByType invalide');
  }

  if (!fileUrl || !fileStorageKey) {
    throw HttpError.badRequest('fileUrl et fileStorageKey requis');
  }

  return transaction(async (db) => {
    const result = await db.query(
      `INSERT INTO ticket_attachments
        (
          ticket_id,
          message_id,
          uploaded_by_type,
          uploaded_by_user_id,
          uploaded_by_client_id,
          file_url,
          file_storage_key,
          file_type,
          size_bytes
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        ticketId,
        messageId,
        uploadedByType,
        uploadedByUserId,
        uploadedByClientId,
        fileUrl,
        fileStorageKey,
        fileType,
        sizeBytes,
      ]
    );

    if (messageId) {
      await db.query(
        `UPDATE ticket_messages
         SET attachment_count = COALESCE(attachment_count, 0) + 1
         WHERE id = $1`,
        [messageId]
      );
    }

    await db.query(
      `UPDATE support_tickets
       SET last_message_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [ticketId]
    );

    await db.query(
      `INSERT INTO ticket_history
        (ticket_id, action, comment, user_id)
       VALUES ($1, 'attachment_added', $2, $3)`,
      [ticketId, historyComment, historyUserId]
    );

    return result.rows[0];
  });
}

async function listTicketAttachments(ticketId) {
  const res = await query(
    `SELECT *
     FROM ticket_attachments
     WHERE ticket_id = $1
     ORDER BY created_at ASC`,
    [ticketId]
  );

  return res.rows;
}

module.exports = {
  addSupportAttachment,
  listTicketAttachments,
};