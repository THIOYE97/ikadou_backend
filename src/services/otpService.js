const crypto = require('crypto');
const { query } = require('../data/db');
const logger = require('../utils/logger');

let emailService = null;
let smsService = null;
let whatsappService = null;

try {
  emailService = require('./emailService');
} catch (_) {}

try {
  smsService = require('./smsService');
} catch (_) {}

try {
  whatsappService = require('./whatsappService');
} catch (_) {}

const OTP_TTL_MINUTES = Number(process.env.CLIENT_OTP_TTL_MINUTES || 10);
const OTP_LENGTH = Number(process.env.CLIENT_OTP_LENGTH || 6);

const generateCode = () => {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = (10 ** OTP_LENGTH) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

const hashCode = (code) =>
  crypto.createHash('sha256').update(String(code)).digest('hex');

const maskTarget = (target, channel) => {
  if (!target) return null;

  if (channel === 'email') {
    const [name, domain] = String(target).split('@');
    if (!domain) return target;
    if (!name || name.length <= 2) return `${name?.[0] || '*'}***@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
  }

  const clean = String(target);
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, 4)}*****${clean.slice(-2)}`;
};

const markPreviousActiveOtpsExpired = async ({ target, purpose }) => {
  await query(
    `UPDATE client_otp_codes
     SET delivery_status = 'expired'
     WHERE target = $1
       AND purpose = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()`,
    [target, purpose]
  );
};

const createOtp = async ({
  clientId = null,
  accountId = null,
  target,
  channel,
  purpose,
  deliveryProvider = null,
  metadata = {},
}) => {
  await markPreviousActiveOtpsExpired({ target, purpose });

  const code = generateCode();
  const codeHash = hashCode(code);

  const result = await query(
    `INSERT INTO client_otp_codes
      (
        client_id,
        account_id,
        target,
        channel,
        purpose,
        code_hash,
        expires_at,
        delivery_status,
        delivery_provider,
        delivery_metadata
      )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       NOW() + ($7 || ' minutes')::interval,
       'pending',
       $8,
       $9::jsonb
     )
     RETURNING *`,
    [
      clientId,
      accountId,
      target,
      channel,
      purpose,
      codeHash,
      String(OTP_TTL_MINUTES),
      deliveryProvider,
      JSON.stringify(metadata || {}),
    ]
  );

  return {
    otp: result.rows[0],
    rawCode: code,
    expiresInMinutes: OTP_TTL_MINUTES,
    maskedTarget: maskTarget(target, channel),
  };
};

const sendOtp = async ({ otpId = null, target, channel, code, purpose }) => {
  try {
    let deliveryRef = null;
    let provider = null;

    if (channel === 'email') {
      provider = 'smtp';

      if (emailService?.sendEmail) {
        const result = await emailService.sendEmail({
          to: target,
          subject: 'Votre code de vérification IKADOU',
          html: `<p>Votre code IKADOU est <strong>${code}</strong>.</p>
                 <p>Il expire dans ${OTP_TTL_MINUTES} minutes.</p>
                 <p>Ne le partagez pas.</p>`,
        });
        deliveryRef = result?.messageId || null;
      } else {
        logger.warn(`[OTP] emailService indisponible — code=${code} target=${target} purpose=${purpose}`);
      }
    } else if (channel === 'sms') {
      provider = 'twilio_sms';

      if (smsService?.sendSms) {
        const result = await smsService.sendSms({
          to: target,
          type: 'otp',
          vars: { code },
        });
        deliveryRef = result?.sid || null;
      } else {
        logger.warn(`[OTP] smsService indisponible — code=${code} target=${target} purpose=${purpose}`);
      }
    } else if (channel === 'whatsapp') {
      provider = 'twilio_whatsapp';

      if (whatsappService?.sendWhatsApp) {
        const result = await whatsappService.sendWhatsApp({
          to: target,
          body: `Bonjour, votre code de vérification IKADOU est : ${code}. Il expire dans ${OTP_TTL_MINUTES} minutes. Ne le partagez pas.`,
        });
        deliveryRef = result?.sid || null;
      } else {
        logger.warn(`[OTP] whatsappService indisponible — code=${code} target=${target} purpose=${purpose}`);
      }
    } else {
      throw new Error(`Canal OTP non supporté: ${channel}`);
    }

    if (otpId) {
      await query(
        `UPDATE client_otp_codes
         SET delivery_status = 'sent',
             delivery_provider = COALESCE($2, delivery_provider),
             delivery_reference = $3
         WHERE id = $1`,
        [otpId, provider, deliveryRef]
      );
    }

    return {
      success: true,
      provider,
      deliveryReference: deliveryRef,
    };
  } catch (error) {
    if (otpId) {
      await query(
        `UPDATE client_otp_codes
         SET delivery_status = 'failed'
         WHERE id = $1`,
        [otpId]
      );
    }

    logger.error(`OTP send failed: ${error.message}`);
    throw error;
  }
};

const createAndSendOtp = async (params) => {
  const { otp, rawCode, expiresInMinutes, maskedTarget } = await createOtp(params);

  await sendOtp({
    otpId: otp.id,
    target: params.target,
    channel: params.channel,
    code: rawCode,
    purpose: params.purpose,
  });

  return {
    otp,
    expiresInMinutes,
    maskedTarget,
  };
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
    await query(
      `UPDATE client_otp_codes
       SET delivery_status = 'expired'
       WHERE id = $1`,
      [otp.id]
    );
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
     SET consumed_at = NOW(),
         delivery_status = 'consumed'
     WHERE id = $1`,
    [otp.id]
  );

  return { ok: true, otp };
};

module.exports = {
  createOtp,
  sendOtp,
  createAndSendOtp,
  verifyOtp,
  maskTarget,
};