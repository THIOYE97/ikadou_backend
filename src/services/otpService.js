const crypto = require('crypto');
const { query } = require('../data/db');
const logger = require('../utils/logger');

let emailService = null;
let smsService = null;

try {
  emailService = require('./emailService');
} catch (_) {}

try {
  smsService = require('./smsService');
} catch (_) {}

const OTP_TTL_MINUTES = Number(process.env.CLIENT_OTP_TTL_MINUTES || 10);

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));

const hashCode = (code) =>
  crypto.createHash('sha256').update(String(code)).digest('hex');

const createOtp = async ({ clientId = null, accountId = null, target, channel, purpose }) => {
  const code = generateCode();
  const codeHash = hashCode(code);

  const result = await query(
    `INSERT INTO client_otp_codes
      (client_id, account_id, target, channel, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' minutes')::interval)
     RETURNING *`,
    [clientId, accountId, target, channel, purpose, codeHash, String(OTP_TTL_MINUTES)]
  );

  return { otp: result.rows[0], rawCode: code };
};

const sendOtp = async ({ target, channel, code, purpose }) => {
  try {
    if (channel === 'email') {
      if (emailService?.sendEmail) {
        await emailService.sendEmail({
          to: target,
          type: 'custom',
          subject: 'Votre code de vérification IKADOU',
          html: `<p>Votre code IKADOU est <strong>${code}</strong>. Il expire dans ${OTP_TTL_MINUTES} minutes.</p>`,
          vars: { code },
        });
      } else {
        logger.warn(`[OTP] emailService.sendEmail indisponible — code=${code} target=${target} purpose=${purpose}`);
      }
    } else if (channel === 'sms') {
      if (smsService?.sendSms) {
        await smsService.sendSms({
          to: target,
          type: 'otp',
          vars: { code },
        });
      } else {
        logger.warn(`[OTP] smsService.sendSms indisponible — code=${code} target=${target} purpose=${purpose}`);
      }
    }
  } catch (error) {
    logger.error(`OTP send failed: ${error.message}`);
    throw error;
  }
};

const verifyOtp = async ({ target, purpose, code }) => {
  const codeHash = hashCode(code);

  const result = await query(
    `SELECT *
     FROM client_otp_codes
     WHERE target = $1
       AND purpose = $2
       AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [target, purpose]
  );

  if (!result.rows.length) {
    return { ok: false, reason: 'not_found' };
  }

  const otp = result.rows[0];

  if (new Date(otp.expires_at) < new Date()) {
    return { ok: false, reason: 'expired', otp };
  }

  if (otp.attempts >= otp.max_attempts) {
    return { ok: false, reason: 'max_attempts', otp };
  }

  if (otp.code_hash !== codeHash) {
    await query(
      `UPDATE client_otp_codes
       SET attempts = attempts + 1
       WHERE id = $1`,
      [otp.id]
    );
    return { ok: false, reason: 'invalid', otp };
  }

  await query(
    `UPDATE client_otp_codes
     SET consumed_at = NOW()
     WHERE id = $1`,
    [otp.id]
  );

  return { ok: true, otp };
};

module.exports = {
  createOtp,
  sendOtp,
  verifyOtp,
};