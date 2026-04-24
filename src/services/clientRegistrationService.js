const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { query } = require('../data/db');
const HttpError = require('../utils/httpError');
const { signClientAccessToken } = require('../utils/clientJwt');
const NotificationService = require('./notificationService');


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
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.CLIENT_REFRESH_TOKEN_TTL_DAYS || 30);

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function normalizePhone(value) {
  return value ? String(value).trim() : null;
}

function randomOtpCode() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = (10 ** OTP_LENGTH) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(48).toString('hex');
}

function maskTarget(target, channel) {
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
}

async function logSessionEvent(sessionId, eventType, channel = null, message = null, metadata = {}) {
  await query(
    `INSERT INTO client_registration_session_events
      (session_id, event_type, channel, message, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [sessionId, eventType, channel, message, JSON.stringify(metadata || {})]
  );
}

async function findClientByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const result = await query(
    `SELECT c.*, caa.id AS auth_account_id
     FROM clients c
     LEFT JOIN client_auth_accounts caa ON caa.client_id = c.id
     WHERE LOWER(c.email) = $1
        OR LOWER(caa.email) = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  return result.rows[0] || null;
}

async function findClientByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const result = await query(
    `SELECT c.*, caa.id AS auth_account_id
     FROM clients c
     LEFT JOIN client_auth_accounts caa ON caa.client_id = c.id
     WHERE c.phone = $1
        OR caa.phone = $1
     LIMIT 1`,
    [normalizedPhone]
  );

  return result.rows[0] || null;
}

async function cancelPendingRegistrationSessions({ email = null, phone = null }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  await query(
    `UPDATE client_registration_sessions
     SET status = 'cancelled',
         cancelled_at = NOW(),
         updated_at = NOW()
     WHERE status = 'pending'
       AND (
         ($1::varchar IS NOT NULL AND LOWER(email) = $1)
         OR
         ($2::varchar IS NOT NULL AND phone = $2)
       )`,
    [normalizedEmail, normalizedPhone]
  );
}

async function createRegistrationSession({
  flow,
  firstName,
  lastName,
  email = null,
  phone = null,
  passwordHash = null,
  country = null,
  city = null,
  channel,
}) {
  const code = randomOtpCode();
  const codeHash = sha256(code);

  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const verificationTarget = channel === 'email' ? normalizedEmail : normalizedPhone;

  const result = await query(
    `INSERT INTO client_registration_sessions
      (
        flow,
        first_name,
        last_name,
        email,
        phone,
        password_hash,
        country,
        city,
        current_channel,
        verification_target,
        otp_code_hash,
        otp_expires_at,
        metadata
      )
     VALUES
      (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11,
        NOW() + ($12 || ' minutes')::interval,
        '{}'::jsonb
      )
     RETURNING *`,
    [
      flow,
      firstName,
      lastName,
      normalizedEmail,
      normalizedPhone,
      passwordHash,
      country,
      city,
      channel,
      verificationTarget,
      codeHash,
      String(OTP_TTL_MINUTES),
    ]
  );

  const session = result.rows[0];
  await logSessionEvent(session.id, 'created', channel, 'Registration session created');

  return {
    session,
    rawCode: code,
  };
}

async function sendOtp({ sessionId, target, channel, code }) {
  try {
    let provider = null;
    let deliveryRef = null;

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
      }
    } else if (channel === 'whatsapp') {
      provider = 'twilio_whatsapp';

      if (whatsappService?.sendWhatsApp) {
        const result = await whatsappService.sendWhatsApp({
          to: target,
          body: `Bonjour, votre code de vérification IKADOU est : ${code}. Il expire dans ${OTP_TTL_MINUTES} minutes.`,
        });
        deliveryRef = result?.sid || null;
      }
    } else {
      throw new Error(`Canal OTP non supporté: ${channel}`);
    }

    await logSessionEvent(sessionId, 'otp_sent', channel, 'OTP sent', {
      provider,
      deliveryReference: deliveryRef,
    });

    return {
      success: true,
      provider,
      deliveryReference: deliveryRef,
    };
  } catch (error) {
    await logSessionEvent(sessionId, 'otp_failed', channel, error.message, {});
    throw error;
  }
}

async function createRefreshToken(clientId) {
  const token = randomToken();

  const result = await query(
    `INSERT INTO client_refresh_tokens (client_id, token, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval)
     RETURNING *`,
    [clientId, token, String(REFRESH_TOKEN_TTL_DAYS)]
  );

  return result.rows[0];
}

async function createAuthSession({
  clientId,
  accountId,
  refreshTokenId = null,
  loginMethod,
}) {
  await query(
    `INSERT INTO client_auth_sessions
      (
        client_id,
        account_id,
        refresh_token_id,
        login_method,
        last_seen_at,
        last_verified_at,
        created_at
      )
     VALUES ($1,$2,$3,$4,NOW(),NOW(),NOW())`,
    [clientId, accountId, refreshTokenId, loginMethod]
  );
}

async function ensureClientAppState(clientId) {
  await query(
    `INSERT INTO client_app_state (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );
}

async function ensureClientNotificationPrefs(clientId) {
  await query(
    `INSERT INTO client_notification_prefs (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );
}

async function createRealClientAndAccountFromSession(session) {
  const clientRes = await query(
    `INSERT INTO clients
      (first_name, last_name, email, phone, country, city, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING *`,
    [
      session.first_name,
      session.last_name,
      session.email,
      session.phone,
      session.country,
      session.city,
    ]
  );

  const client = clientRes.rows[0];

  const authMethods =
    session.flow === 'email'
      ? ['email_password']
      : ['phone_otp'];

  const preferredLogin =
    session.flow === 'email'
      ? 'email'
      : 'phone';

  const accountRes = await query(
    `INSERT INTO client_auth_accounts
      (
        client_id,
        email,
        phone,
        password_hash,
        auth_methods,
        preferred_login,
        preferred_otp_channel,
        is_email_verified,
        is_phone_verified,
        email_verified_at,
        phone_verified_at,
        whatsapp_verified_at,
        last_strong_verified_at,
        is_active
      )
     VALUES (
       $1, $2, $3, $4,
       $5::jsonb, $6, $7,
       $8, $9,
       $10, $11, $12,
       NOW(),
       TRUE
     )
     RETURNING *`,
    [
      client.id,
      session.email,
      session.phone,
      session.password_hash,
      JSON.stringify(authMethods),
      preferredLogin,
      session.current_channel,
      session.flow === 'email',
      session.flow === 'phone',
      session.flow === 'email' ? new Date() : null,
      session.flow === 'phone' ? new Date() : null,
      session.current_channel === 'whatsapp' ? new Date() : null,
    ]
  );

  const account = accountRes.rows[0];

  await ensureClientAppState(client.id);
  await ensureClientNotificationPrefs(client.id);

  return { client, account };
}

function buildClientPayload(client) {
  return {
    id: client.id,
    first_name: client.first_name,
    last_name: client.last_name,
    email: client.email,
    phone: client.phone,
    status: client.status,
  };
}

async function finalizeAuthenticatedSession({ client, account, loginMethod }) {
  const accessToken = signClientAccessToken(buildClientPayload(client));
  const refreshTokenRow = await createRefreshToken(client.id);

  await createAuthSession({
    clientId: client.id,
    accountId: account.id,
    refreshTokenId: refreshTokenRow.id,
    loginMethod,
  });

  return {
    status: 'authenticated',
    client: buildClientPayload(client),
    accessToken,
    refreshToken: refreshTokenRow.token,
  };
}

async function registerEmailInit({
  firstName,
  lastName,
  email,
  password,
  country = null,
  city = null,
}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw HttpError.badRequest('Email requis');
  }

  if (!password || password.length < 6) {
    throw HttpError.badRequest('Mot de passe invalide');
  }

  const existingClient = await findClientByEmail(normalizedEmail);
  if (existingClient) {
    throw HttpError.conflict('Un compte existe déjà avec cet email');
  }

  await cancelPendingRegistrationSessions({ email: normalizedEmail });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { session, rawCode } = await createRegistrationSession({
    flow: 'email',
    firstName,
    lastName,
    email: normalizedEmail,
    passwordHash,
    country,
    city,
    channel: 'email',
  });

  await sendOtp({
    sessionId: session.id,
    target: session.verification_target,
    channel: 'email',
    code: rawCode,
  });

  return {
    status: 'pending_verification',
    registrationSessionId: session.id,
    verification: {
      purpose: 'register_email',
      channel: 'email',
      target: maskTarget(session.verification_target, 'email'),
      expiresInMinutes: OTP_TTL_MINUTES,
    },
  };
}

async function registerPhoneInit({
  firstName,
  lastName,
  phone,
  channel,
  country = null,
  city = null,
}) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw HttpError.badRequest('Téléphone requis');
  }

  if (!['sms', 'whatsapp'].includes(channel)) {
    throw HttpError.badRequest('Canal OTP invalide');
  }

  const existingClient = await findClientByPhone(normalizedPhone);
  if (existingClient) {
    throw HttpError.conflict('Un compte existe déjà avec ce téléphone');
  }

  await cancelPendingRegistrationSessions({ phone: normalizedPhone });

  const { session, rawCode } = await createRegistrationSession({
    flow: 'phone',
    firstName,
    lastName,
    phone: normalizedPhone,
    country,
    city,
    channel,
  });

  await sendOtp({
    sessionId: session.id,
    target: session.verification_target,
    channel,
    code: rawCode,
  });

  return {
    status: 'pending_verification',
    registrationSessionId: session.id,
    verification: {
      purpose: 'register_phone',
      channel,
      target: maskTarget(session.verification_target, channel),
      expiresInMinutes: OTP_TTL_MINUTES,
    },
  };
}

async function findPendingSession(sessionId) {
  const result = await query(
    `SELECT *
     FROM client_registration_sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId]
  );

  return result.rows[0] || null;
}

async function registerResend({
  registrationSessionId,
  channel = null,
}) {
  const session = await findPendingSession(registrationSessionId);

  if (!session) {
    throw HttpError.notFound('Session d’inscription introuvable');
  }

  if (session.status !== 'pending') {
    throw HttpError.badRequest('Cette session n’est plus active');
  }

  if (new Date(session.otp_expires_at) < new Date()) {
    await query(
      `UPDATE client_registration_sessions
       SET status = 'expired',
           expires_reason = 'otp_expired',
           updated_at = NOW()
       WHERE id = $1`,
      [session.id]
    );
    throw HttpError.badRequest('La session a expiré');
  }

  let nextChannel = channel || session.current_channel;

  if (session.flow === 'email') {
    nextChannel = 'email';
  }

  if (session.flow === 'phone' && !['sms', 'whatsapp'].includes(nextChannel)) {
    throw HttpError.badRequest('Canal invalide');
  }

  const target = nextChannel === 'email' ? session.email : session.phone;
  const rawCode = randomOtpCode();
  const codeHash = sha256(rawCode);

  await query(
    `UPDATE client_registration_sessions
     SET current_channel = $2,
         verification_target = $3,
         otp_code_hash = $4,
         otp_expires_at = NOW() + ($5 || ' minutes')::interval,
         otp_attempts = 0,
         resend_count = resend_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [session.id, nextChannel, target, codeHash, String(OTP_TTL_MINUTES)]
  );

  await sendOtp({
    sessionId: session.id,
    target,
    channel: nextChannel,
    code: rawCode,
  });

  await logSessionEvent(session.id, 'otp_resent', nextChannel, 'OTP resent');

  return {
    status: 'pending_verification',
    registrationSessionId: session.id,
    verification: {
      channel: nextChannel,
      target: maskTarget(target, nextChannel),
      expiresInMinutes: OTP_TTL_MINUTES,
    },
  };
}

async function registerVerify({
  registrationSessionId,
  code,
}) {
  const session = await findPendingSession(registrationSessionId);

  if (!session) {
    throw HttpError.notFound('Session d’inscription introuvable');
  }

  if (session.status !== 'pending') {
    throw HttpError.badRequest('Cette session n’est plus active');
  }

  if (new Date(session.otp_expires_at) < new Date()) {
    await query(
      `UPDATE client_registration_sessions
       SET status = 'expired',
           expires_reason = 'otp_expired',
           updated_at = NOW()
       WHERE id = $1`,
      [session.id]
    );
    throw HttpError.badRequest('Code expiré');
  }

  if (session.otp_attempts >= session.otp_max_attempts) {
    throw HttpError.badRequest('Nombre maximum de tentatives atteint');
  }

  const codeHash = sha256(code);
  if (codeHash !== session.otp_code_hash) {
    await query(
      `UPDATE client_registration_sessions
       SET otp_attempts = otp_attempts + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [session.id]
    );

    await logSessionEvent(session.id, 'otp_invalid', session.current_channel, 'Invalid OTP');
    throw HttpError.badRequest('Code invalide');
  }

  // Double-check final uniqueness right before creating real account
  if (session.email) {
    const existingEmailClient = await findClientByEmail(session.email);
    if (existingEmailClient) {
      throw HttpError.conflict('Un compte existe déjà avec cet email');
    }
  }

  if (session.phone) {
    const existingPhoneClient = await findClientByPhone(session.phone);
    if (existingPhoneClient) {
      throw HttpError.conflict('Un compte existe déjà avec ce téléphone');
    }
  }

  await query('BEGIN');

  try {
    const { client, account } = await createRealClientAndAccountFromSession(session);

    await query(
      `UPDATE client_registration_sessions
       SET status = 'consumed',
           verified_at = NOW(),
           consumed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [session.id]
    );

    await logSessionEvent(session.id, 'otp_verified', session.current_channel, 'OTP verified');
    await logSessionEvent(session.id, 'consumed', session.current_channel, 'Registration session consumed');

    const authPayload = await finalizeAuthenticatedSession({
      client,
      account,
      loginMethod: session.flow === 'email' ? 'email' : 'phone',
    });

       await query('COMMIT');

    NotificationService.notifyClientWelcomeConfirmed({
      client,
      sentBy: null,
    }).catch(() => {});

    return authPayload;
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
}

module.exports = {
  registerEmailInit,
  registerPhoneInit,
  registerResend,
  registerVerify,
};