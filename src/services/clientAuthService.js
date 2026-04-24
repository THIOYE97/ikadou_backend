const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { OAuth2Client } = require('google-auth-library');
const NotificationService = require('./notificationService');


const { query } = require('../data/db');
const HttpError = require('../utils/httpError');
const { signClientAccessToken } = require('../utils/clientJwt');
const { createAndSendOtp, verifyOtp, maskTarget } = require('./otpService');

const REFRESH_TOKEN_TTL_DAYS = Number(process.env.CLIENT_REFRESH_TOKEN_TTL_DAYS || 30);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const STEP_UP_WINDOW_DAYS = Number(process.env.CLIENT_STEP_UP_DAYS || 7);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const randomToken = () => crypto.randomBytes(48).toString('hex');

const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : null);
const normalizePhone = (value) => (value ? String(value).trim() : null);

const getStepUpThresholdDate = () => {
  const d = new Date();
  d.setDate(d.getDate() - STEP_UP_WINDOW_DAYS);
  return d;
};

const needsStepUp = (account) => {
  if (!account?.last_strong_verified_at) return true;
  return new Date(account.last_strong_verified_at) < getStepUpThresholdDate();
};

const buildClientPayload = (client) => ({
  id: client.id,
  first_name: client.first_name,
  last_name: client.last_name,
  email: client.email,
  phone: client.phone,
  status: client.status,
});
async function sendWelcomeEmailOnce(clientId) {
  const res = await query(
    `
    SELECT id, first_name, last_name, email, welcome_email_sent_at
    FROM clients
    WHERE id = $1
    LIMIT 1
    `,
    [clientId]
  );

  const client = res.rows[0];

  if (!client?.email || client.welcome_email_sent_at) return;

  await NotificationService.notifyClientWelcomeConfirmed({
    client,
    sentBy: null,
  });

  await query(
    `
    UPDATE clients
    SET welcome_email_sent_at = NOW()
    WHERE id = $1
      AND welcome_email_sent_at IS NULL
    `,
    [clientId]
  );
}

const ensureClientAppState = async (clientId) => {
  await query(
    `INSERT INTO client_app_state (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );
};

const ensureClientNotificationPrefs = async (clientId) => {
  await query(
    `INSERT INTO client_notification_prefs (client_id)
     VALUES ($1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId]
  );
};

const findLeadByEmailOrPhone = async ({ email, phone }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const result = await query(
    `SELECT *
     FROM leads
     WHERE ($1::varchar IS NOT NULL AND LOWER(email) = $1)
        OR ($2::varchar IS NOT NULL AND phone = $2)
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalizedEmail, normalizedPhone]
  );

  return result.rows[0] || null;
};

const linkLeadToClient = async ({ clientId, email, phone }) => {
  const lead = await findLeadByEmailOrPhone({ email, phone });
  if (!lead) return null;

  const updated = await query(
    `UPDATE leads
     SET client_id = $1,
         status = 'converted',
         converted_at = NOW(),
         converted_by = 'system',
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [clientId, lead.id]
  );

  return updated.rows[0] || null;
};

const getClientById = async (clientId) => {
  const result = await query(
    `SELECT *
     FROM clients
     WHERE id = $1
     LIMIT 1`,
    [clientId]
  );

  return result.rows[0] || null;
};

const getAccountByClientId = async (clientId) => {
  const result = await query(
    `SELECT *
     FROM client_auth_accounts
     WHERE client_id = $1
     LIMIT 1`,
    [clientId]
  );

  return result.rows[0] || null;
};

const getAccountByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const result = await query(
    `SELECT caa.*, c.first_name, c.last_name, c.status, c.email AS client_email, c.phone AS client_phone
     FROM client_auth_accounts caa
     JOIN clients c ON c.id = caa.client_id
     WHERE LOWER(caa.email) = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  return result.rows[0] || null;
};

const getAccountByPhone = async (phone) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const result = await query(
    `SELECT caa.*, c.first_name, c.last_name, c.status, c.email AS client_email, c.phone AS client_phone
     FROM client_auth_accounts caa
     JOIN clients c ON c.id = caa.client_id
     WHERE caa.phone = $1
     LIMIT 1`,
    [normalizedPhone]
  );

  return result.rows[0] || null;
};

const getAccountByGoogleSub = async (googleSub) => {
  const result = await query(
    `SELECT caa.*, c.first_name, c.last_name, c.status, c.email AS client_email, c.phone AS client_phone
     FROM client_auth_accounts caa
     JOIN clients c ON c.id = caa.client_id
     WHERE caa.google_sub = $1
     LIMIT 1`,
    [googleSub]
  );

  return result.rows[0] || null;
};

const createClient = async ({
  firstName,
  lastName,
  email = null,
  phone = null,
  country = null,
  city = null,
}) => {
  const result = await query(
    `INSERT INTO clients
      (first_name, last_name, email, phone, country, city, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING *`,
    [firstName, lastName, email, phone, country, city]
  );

  return result.rows[0];
};

const updateClientBasicInfo = async (clientId, { email, phone, firstName, lastName, country, city }) => {
  const result = await query(
    `UPDATE clients
     SET first_name = COALESCE($2, first_name),
         last_name = COALESCE($3, last_name),
         email = COALESCE($4, email),
         phone = COALESCE($5, phone),
         country = COALESCE($6, country),
         city = COALESCE($7, city),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [clientId, firstName || null, lastName || null, email || null, phone || null, country || null, city || null]
  );

  return result.rows[0];
};

const createClientAuthAccount = async ({
  clientId,
  email = null,
  phone = null,
  passwordHash = null,
  googleSub = null,
  googleEmail = null,
  authMethods = [],
  preferredLogin = null,
  preferredOtpChannel = null,
}) => {
  const result = await query(
    `INSERT INTO client_auth_accounts
      (
        client_id,
        email,
        phone,
        password_hash,
        google_sub,
        google_email,
        auth_methods,
        preferred_login,
        preferred_otp_channel,
        is_email_verified,
        is_phone_verified,
        is_active
      )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
       FALSE, FALSE, TRUE
     )
     RETURNING *`,
    [
      clientId,
      email,
      phone,
      passwordHash,
      googleSub,
      googleEmail,
      JSON.stringify(authMethods),
      preferredLogin,
      preferredOtpChannel,
    ]
  );

  return result.rows[0];
};

const updateAccountVerification = async ({
  accountId,
  verifyEmail = false,
  verifyPhone = false,
  verifyWhatsApp = false,
  lastLoginMethod = null,
}) => {
  const result = await query(
    `UPDATE client_auth_accounts
     SET is_email_verified = CASE WHEN $2 THEN TRUE ELSE is_email_verified END,
         is_phone_verified = CASE WHEN $3 THEN TRUE ELSE is_phone_verified END,
         email_verified_at = CASE WHEN $2 THEN NOW() ELSE email_verified_at END,
         phone_verified_at = CASE WHEN $3 THEN NOW() ELSE phone_verified_at END,
         whatsapp_verified_at = CASE WHEN $4 THEN NOW() ELSE whatsapp_verified_at END,
         last_strong_verified_at = NOW(),
         last_login_method = COALESCE($5, last_login_method),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [accountId, verifyEmail, verifyPhone, verifyWhatsApp, lastLoginMethod]
  );

  return result.rows[0];
};

const touchLastLogin = async ({ accountId, loginMethod }) => {
  await query(
    `UPDATE client_auth_accounts
     SET last_login_at = NOW(),
         last_login_method = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, loginMethod]
  );
};

const createRefreshToken = async (clientId) => {
  const token = randomToken();

  const result = await query(
    `INSERT INTO client_refresh_tokens (client_id, token, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval)
     RETURNING *`,
    [clientId, token, String(REFRESH_TOKEN_TTL_DAYS)]
  );

  return result.rows[0];
};

const createAuthSession = async ({
  clientId,
  accountId,
  refreshTokenId = null,
  loginMethod,
  lastVerifiedAt = null,
  deviceId = null,
  platform = null,
  appVersion = null,
}) => {
  const result = await query(
    `INSERT INTO client_auth_sessions
      (
        client_id,
        account_id,
        refresh_token_id,
        login_method,
        device_id,
        platform,
        app_version,
        last_seen_at,
        last_verified_at,
        created_at
      )
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,NOW())
     RETURNING *`,
    [clientId, accountId, refreshTokenId, loginMethod, deviceId, platform, appVersion, lastVerifiedAt]
  );

  return result.rows[0];
};

const issueSession = async ({
  client,
  account,
  loginMethod,
  strongVerified = false,
  deviceId = null,
  platform = null,
  appVersion = null,
}) => {
  const accessToken = signClientAccessToken(buildClientPayload(client));
  const refreshTokenRow = await createRefreshToken(client.id);

  await createAuthSession({
    clientId: client.id,
    accountId: account.id,
    refreshTokenId: refreshTokenRow.id,
    loginMethod,
    lastVerifiedAt: strongVerified ? new Date() : null,
    deviceId,
    platform,
    appVersion,
  });

  await touchLastLogin({
    accountId: account.id,
    loginMethod,
  });

  return {
    client: buildClientPayload(client),
    accessToken,
    refreshToken: refreshTokenRow.token,
  };
};

const verifyGoogleIdToken = async (idToken) => {
  if (!googleClient) {
    throw HttpError.badRequest('Google Sign-In non configuré côté serveur');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw HttpError.unauthorized('Token Google invalide');
  }

  return {
    sub: payload.sub,
    email: normalizeEmail(payload.email),
    emailVerified: !!payload.email_verified,
    firstName: payload.given_name || null,
    lastName: payload.family_name || null,
    fullName: payload.name || null,
  };
};

const registerEmail = async ({
  firstName,
  lastName,
  email,
  password,
  country,
  city,
}) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) {
    throw HttpError.badRequest('Email et mot de passe requis');
  }

  const existing = await getAccountByEmail(normalizedEmail);
  if (existing) {
    throw HttpError.conflict('Un compte existe déjà avec cet email');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const client = await createClient({
    firstName,
    lastName,
    email: normalizedEmail,
    phone: null,
    country,
    city,
  });

  const account = await createClientAuthAccount({
    clientId: client.id,
    email: normalizedEmail,
    passwordHash,
    authMethods: ['email_password'],
    preferredLogin: 'email',
    preferredOtpChannel: 'email',
  });

  await ensureClientAppState(client.id);
  await ensureClientNotificationPrefs(client.id);
  await linkLeadToClient({ clientId: client.id, email: normalizedEmail, phone: null });

  const otpResult = await createAndSendOtp({
    clientId: client.id,
    accountId: account.id,
    target: normalizedEmail,
    channel: 'email',
    purpose: 'register_email',
    deliveryProvider: 'smtp',
  });

  return {
    status: 'pending_verification',
    verification: {
      purpose: 'register_email',
      channel: 'email',
      target: otpResult.maskedTarget,
      expiresInMinutes: otpResult.expiresInMinutes,
    },
    client: buildClientPayload(client),
  };
};

const registerPhone = async ({
  firstName,
  lastName,
  phone,
  channel,
  country,
  city,
}) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    throw HttpError.badRequest('Numéro de téléphone requis');
  }
  if (!['sms', 'whatsapp'].includes(channel)) {
    throw HttpError.badRequest('Canal OTP invalide');
  }

  const existing = await getAccountByPhone(normalizedPhone);
  if (existing) {
    throw HttpError.conflict('Un compte existe déjà avec ce téléphone');
  }

  const client = await createClient({
    firstName,
    lastName,
    email: null,
    phone: normalizedPhone,
    country,
    city,
  });

  const account = await createClientAuthAccount({
    clientId: client.id,
    phone: normalizedPhone,
    passwordHash: null,
    authMethods: ['phone_otp'],
    preferredLogin: 'phone',
    preferredOtpChannel: channel,
  });

  await ensureClientAppState(client.id);
  await ensureClientNotificationPrefs(client.id);
  await linkLeadToClient({ clientId: client.id, email: null, phone: normalizedPhone });

  const otpResult = await createAndSendOtp({
    clientId: client.id,
    accountId: account.id,
    target: normalizedPhone,
    channel,
    purpose: 'register_phone',
    deliveryProvider: channel === 'sms' ? 'twilio_sms' : 'twilio_whatsapp',
  });

  return {
    status: 'pending_verification',
    verification: {
      purpose: 'register_phone',
      channel,
      target: otpResult.maskedTarget,
      expiresInMinutes: otpResult.expiresInMinutes,
    },
    client: buildClientPayload(client),
  };
};

const registerGoogle = async ({
  idToken,
  phone = null,
  email = null,
  verificationChannel = null,
  country = null,
  city = null,
}) => {
  const googleUser = await verifyGoogleIdToken(idToken);

  let account = await getAccountByGoogleSub(googleUser.sub);

  if (!account && googleUser.email) {
    account = await getAccountByEmail(googleUser.email);
  }

  let client;

  if (!account) {
    client = await createClient({
      firstName: googleUser.firstName || 'Client',
      lastName: googleUser.lastName || 'Ikadou',
      email: googleUser.email || normalizeEmail(email),
      phone: normalizePhone(phone),
      country,
      city,
    });

    account = await createClientAuthAccount({
      clientId: client.id,
      email: googleUser.email || normalizeEmail(email),
      phone: normalizePhone(phone),
      googleSub: googleUser.sub,
      googleEmail: googleUser.email,
      authMethods: ['google'],
      preferredLogin: 'google',
      preferredOtpChannel: verificationChannel || (googleUser.email ? 'email' : null),
    });

    await query(
      `INSERT INTO client_auth_identities
        (account_id, provider, provider_user_id, provider_email)
       VALUES ($1, 'google', $2, $3)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [account.id, googleUser.sub, googleUser.email]
    );

    await ensureClientAppState(client.id);
    await ensureClientNotificationPrefs(client.id);
    await linkLeadToClient({
      clientId: client.id,
      email: googleUser.email,
      phone: normalizePhone(phone),
    });
  } else {
    client = await getClientById(account.client_id);

    await query(
      `UPDATE client_auth_accounts
       SET google_sub = COALESCE(google_sub, $2),
           google_email = COALESCE(google_email, $3),
           auth_methods = CASE
             WHEN auth_methods @> '["google"]'::jsonb THEN auth_methods
             ELSE auth_methods || '["google"]'::jsonb
           END,
           preferred_login = COALESCE(preferred_login, 'google'),
           updated_at = NOW()
       WHERE id = $1`,
      [account.id, googleUser.sub, googleUser.email]
    );

    await query(
      `INSERT INTO client_auth_identities
        (account_id, provider, provider_user_id, provider_email)
       VALUES ($1, 'google', $2, $3)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [account.id, googleUser.sub, googleUser.email]
    );

    account = await getAccountByClientId(account.client_id);
  }

  const contactEmail = normalizeEmail(email) || account.email || googleUser.email;
  const contactPhone = normalizePhone(phone) || account.phone;

  let target = null;
  let channel = null;
  let purpose = 'verify_contact';

  if (verificationChannel === 'email') {
    if (!contactEmail) throw HttpError.badRequest('Aucun email disponible pour vérification');
    target = contactEmail;
    channel = 'email';
  } else if (verificationChannel === 'sms' || verificationChannel === 'whatsapp') {
    if (!contactPhone) throw HttpError.badRequest('Aucun téléphone disponible pour vérification');
    target = contactPhone;
    channel = verificationChannel;
  } else if (contactEmail) {
    target = contactEmail;
    channel = 'email';
  } else if (contactPhone) {
    target = contactPhone;
    channel = 'sms';
  } else {
    throw HttpError.badRequest('Un email ou un téléphone vérifiable est requis pour terminer l’inscription Google');
  }

  if (contactEmail && contactEmail !== account.email) {
    await query(
      `UPDATE client_auth_accounts
       SET email = COALESCE(email, $2),
           updated_at = NOW()
       WHERE id = $1`,
      [account.id, contactEmail]
    );
    await updateClientBasicInfo(client.id, { email: contactEmail });
  }

  if (contactPhone && contactPhone !== account.phone) {
    await query(
      `UPDATE client_auth_accounts
       SET phone = COALESCE(phone, $2),
           updated_at = NOW()
       WHERE id = $1`,
      [account.id, contactPhone]
    );
    await updateClientBasicInfo(client.id, { phone: contactPhone });
  }

  const otpResult = await createAndSendOtp({
    clientId: client.id,
    accountId: account.id,
    target,
    channel,
    purpose,
    deliveryProvider:
      channel === 'email'
        ? 'smtp'
        : channel === 'sms'
        ? 'twilio_sms'
        : 'twilio_whatsapp',
  });

  return {
    status: 'pending_verification',
    verification: {
      purpose,
      channel,
      target: otpResult.maskedTarget,
      expiresInMinutes: otpResult.expiresInMinutes,
    },
    client: buildClientPayload(client),
  };
};

const verifyRegisterOtp = async ({ target, purpose, code }) => {
  const verification = await verifyOtp({ target, purpose, code });

  if (!verification.ok) {
    throw HttpError.badRequest(`Code invalide (${verification.reason})`);
  }

  const otp = verification.otp;
  const account = await getAccountByClientId(otp.client_id);
  const client = await getClientById(otp.client_id);

  if (!account || !client) {
    throw HttpError.notFound('Compte introuvable');
  }

  if (purpose === 'register_email') {
  await updateAccountVerification({
    accountId: account.id,
    verifyEmail: true,
    lastLoginMethod: 'email',
  });

  const session = await issueSession({
    client,
    account: await getAccountByClientId(client.id),
    loginMethod: 'email',
    strongVerified: true,
  });

  await sendWelcomeEmailOnce(client.id);

  return {
    status: 'verified',
    ...session,
  };
}
  if (purpose === 'register_phone') {
  await updateAccountVerification({
    accountId: account.id,
    verifyPhone: true,
    verifyWhatsApp: otp.channel === 'whatsapp',
    lastLoginMethod: 'phone',
  });

  const session = await issueSession({
    client,
    account: await getAccountByClientId(client.id),
    loginMethod: 'phone',
    strongVerified: true,
  });

  await sendWelcomeEmailOnce(client.id);

  return {
    status: 'verified',
    ...session,
  };
}
  if (purpose === 'verify_contact') {
  await updateAccountVerification({
    accountId: account.id,
    verifyEmail: otp.channel === 'email',
    verifyPhone: otp.channel === 'sms' || otp.channel === 'whatsapp',
    verifyWhatsApp: otp.channel === 'whatsapp',
    lastLoginMethod: account.preferred_login || 'google',
  });

  await query(
    `UPDATE client_app_state
     SET onboarding_completed = TRUE,
         onboarding_completed_at = NOW(),
         primary_contact_type = CASE
           WHEN $2 = 'email' THEN 'email'
           ELSE 'phone'
         END,
         google_linked = TRUE,
         updated_at = NOW()
     WHERE client_id = $1`,
    [client.id, otp.channel]
  );

  const session = await issueSession({
    client,
    account: await getAccountByClientId(client.id),
    loginMethod: 'google',
    strongVerified: true,
  });

  await sendWelcomeEmailOnce(client.id);

  return {
    status: 'verified',
    ...session,
  };
}
};

const loginEmail = async ({ email, password }) => {
  const normalizedEmail = normalizeEmail(email);
  const accountRow = await getAccountByEmail(normalizedEmail);

  if (!accountRow) {
    throw HttpError.forbidden('Identifiants invalides');
  }

  if (!accountRow.is_active || accountRow.status !== 'active') {
    throw HttpError.forbidden('Compte indisponible');
  }

  if (!accountRow.password_hash) {
    throw HttpError.badRequest('Ce compte n’utilise pas le login par mot de passe');
  }

  const ok = await bcrypt.compare(password, accountRow.password_hash);
  if (!ok) {
    throw HttpError.forbidden('Identifiants invalides');
  }

  const client = await getClientById(accountRow.client_id);

  if (needsStepUp(accountRow)) {
    const target = accountRow.is_email_verified
      ? accountRow.email
      : accountRow.is_phone_verified
      ? accountRow.phone
      : null;

    const channel = accountRow.is_email_verified
      ? 'email'
      : accountRow.preferred_otp_channel === 'whatsapp'
      ? 'whatsapp'
      : 'sms';

    if (!target) {
      throw HttpError.forbidden('Aucun contact vérifié disponible pour revalidation');
    }

    const otpResult = await createAndSendOtp({
      clientId: client.id,
      accountId: accountRow.id,
      target,
      channel,
      purpose: 'login_reverify',
      deliveryProvider:
        channel === 'email'
          ? 'smtp'
          : channel === 'sms'
          ? 'twilio_sms'
          : 'twilio_whatsapp',
    });

    return {
      status: 'verification_required',
      reason: 'stale_session',
      verification: {
        purpose: 'login_reverify',
        channel,
        target: otpResult.maskedTarget,
        expiresInMinutes: otpResult.expiresInMinutes,
      },
      client: buildClientPayload(client),
    };
  }

  return {
    status: 'authenticated',
    ...(await issueSession({
      client,
      account: accountRow,
      loginMethod: 'email',
      strongVerified: false,
    })),
  };
};

const loginPhoneRequestCode = async ({ phone, channel }) => {
  const normalizedPhone = normalizePhone(phone);
  if (!['sms', 'whatsapp'].includes(channel)) {
    throw HttpError.badRequest('Canal OTP invalide');
  }

  const account = await getAccountByPhone(normalizedPhone);
  if (!account) {
    throw HttpError.forbidden('Compte introuvable');
  }

  if (!account.is_active || account.status !== 'active') {
    throw HttpError.forbidden('Compte indisponible');
  }

  const otpResult = await createAndSendOtp({
    clientId: account.client_id,
    accountId: account.id,
    target: normalizedPhone,
    channel,
    purpose: 'login_phone',
    deliveryProvider: channel === 'sms' ? 'twilio_sms' : 'twilio_whatsapp',
  });

  return {
    status: 'code_sent',
    verification: {
      purpose: 'login_phone',
      channel,
      target: otpResult.maskedTarget,
      expiresInMinutes: otpResult.expiresInMinutes,
    },
  };
};

const loginPhoneVerifyCode = async ({ phone, code }) => {
  const normalizedPhone = normalizePhone(phone);

  const verification = await verifyOtp({
    target: normalizedPhone,
    purpose: 'login_phone',
    code,
  });

  if (!verification.ok) {
    throw HttpError.badRequest(`Code invalide (${verification.reason})`);
  }

  const account = await getAccountByPhone(normalizedPhone);
  if (!account) {
    throw HttpError.forbidden('Compte introuvable');
  }

  const client = await getClientById(account.client_id);

  await updateAccountVerification({
    accountId: account.id,
    verifyPhone: true,
    verifyWhatsApp: verification.otp.channel === 'whatsapp',
    lastLoginMethod: 'phone',
  });

  return {
    status: 'authenticated',
    ...(await issueSession({
      client,
      account: await getAccountByClientId(client.id),
      loginMethod: 'phone',
      strongVerified: true,
    })),
  };
};

const verifyLoginOtp = async ({ target, code }) => {
  const verification = await verifyOtp({
    target,
    purpose: 'login_reverify',
    code,
  });

  if (!verification.ok) {
    throw HttpError.badRequest(`Code invalide (${verification.reason})`);
  }

  const otp = verification.otp;
  const account = await getAccountByClientId(otp.client_id);
  const client = await getClientById(otp.client_id);

  if (!account || !client) {
    throw HttpError.notFound('Compte introuvable');
  }

  await updateAccountVerification({
    accountId: account.id,
    verifyEmail: otp.channel === 'email',
    verifyPhone: otp.channel === 'sms' || otp.channel === 'whatsapp',
    verifyWhatsApp: otp.channel === 'whatsapp',
    lastLoginMethod: account.last_login_method || account.preferred_login || 'email',
  });

  return {
    status: 'authenticated',
    ...(await issueSession({
      client,
      account: await getAccountByClientId(client.id),
      loginMethod: account.last_login_method || account.preferred_login || 'email',
      strongVerified: true,
    })),
  };
};

const loginGoogle = async ({ idToken }) => {
  const googleUser = await verifyGoogleIdToken(idToken);

  let account = await getAccountByGoogleSub(googleUser.sub);
  if (!account && googleUser.email) {
    account = await getAccountByEmail(googleUser.email);
  }

  if (!account) {
    return registerGoogle({
      idToken,
      verificationChannel: googleUser.email ? 'email' : null,
    });
  }

  const client = await getClientById(account.client_id);

  await query(
    `UPDATE client_auth_accounts
     SET google_sub = COALESCE(google_sub, $2),
         google_email = COALESCE(google_email, $3),
         auth_methods = CASE
           WHEN auth_methods @> '["google"]'::jsonb THEN auth_methods
           ELSE auth_methods || '["google"]'::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1`,
    [account.id, googleUser.sub, googleUser.email]
  );

  account = await getAccountByClientId(account.client_id);

  if (needsStepUp(account)) {
    const target = account.is_email_verified
      ? account.email
      : account.is_phone_verified
      ? account.phone
      : null;

    const channel = account.is_email_verified
      ? 'email'
      : account.preferred_otp_channel === 'whatsapp'
      ? 'whatsapp'
      : 'sms';

    if (!target) {
      throw HttpError.forbidden('Aucun contact vérifié disponible pour revalidation');
    }

    const otpResult = await createAndSendOtp({
      clientId: client.id,
      accountId: account.id,
      target,
      channel,
      purpose: 'login_reverify',
      deliveryProvider:
        channel === 'email'
          ? 'smtp'
          : channel === 'sms'
          ? 'twilio_sms'
          : 'twilio_whatsapp',
    });

    return {
      status: 'verification_required',
      reason: 'stale_session',
      verification: {
        purpose: 'login_reverify',
        channel,
        target: otpResult.maskedTarget,
        expiresInMinutes: otpResult.expiresInMinutes,
      },
      client: buildClientPayload(client),
    };
  }

  return {
    status: 'authenticated',
    ...(await issueSession({
      client,
      account,
      loginMethod: 'google',
      strongVerified: false,
    })),
  };
};

const forgotPassword = async ({ email }) => {
  const normalizedEmail = normalizeEmail(email);
  const account = await getAccountByEmail(normalizedEmail);

  if (!account) {
    return {
      success: true,
      message: 'Si ce compte existe, un code de réinitialisation a été envoyé.',
    };
  }

  if (!account.password_hash) {
    throw HttpError.badRequest('Ce compte n’utilise pas le mot de passe');
  }

  const otpResult = await createAndSendOtp({
    clientId: account.client_id,
    accountId: account.id,
    target: normalizedEmail,
    channel: 'email',
    purpose: 'reset_password',
    deliveryProvider: 'smtp',
  });

  return {
    success: true,
    message: 'Code de réinitialisation envoyé.',
    verification: {
      purpose: 'reset_password',
      channel: 'email',
      target: otpResult.maskedTarget,
      expiresInMinutes: otpResult.expiresInMinutes,
    },
  };
};

const resetPassword = async ({ email, code, newPassword }) => {
  const normalizedEmail = normalizeEmail(email);
  const verification = await verifyOtp({
    target: normalizedEmail,
    purpose: 'reset_password',
    code,
  });

  if (!verification.ok) {
    throw HttpError.badRequest(`Code invalide (${verification.reason})`);
  }

  const account = await getAccountByEmail(normalizedEmail);
  if (!account) {
    throw HttpError.notFound('Compte introuvable');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await query(
    `UPDATE client_auth_accounts
     SET password_hash = $2,
         auth_methods = CASE
           WHEN auth_methods @> '["email_password"]'::jsonb THEN auth_methods
           ELSE auth_methods || '["email_password"]'::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1`,
    [account.id, passwordHash]
  );

  return { success: true, message: 'Mot de passe réinitialisé avec succès.' };
};

const refresh = async ({ refreshToken }) => {
  const result = await query(
    `SELECT crt.*, c.*
     FROM client_refresh_tokens crt
     JOIN clients c ON c.id = crt.client_id
     WHERE crt.token = $1
       AND crt.revoked_at IS NULL
       AND crt.expires_at > NOW()
     LIMIT 1`,
    [refreshToken]
  );

  if (!result.rows.length) {
    throw HttpError.forbidden('Refresh token invalide ou expiré');
  }

  const row = result.rows[0];

  const client = {
    id: row.client_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
  };

  return {
    client,
    accessToken: signClientAccessToken(client),
  };
};

const logout = async ({ refreshToken }) => {
  await query(
    `UPDATE client_refresh_tokens
     SET revoked_at = NOW()
     WHERE token = $1`,
    [refreshToken]
  );

  return { success: true };
};

module.exports = {
  registerEmail,
  registerPhone,
  registerGoogle,
  verifyRegisterOtp,
  loginEmail,
  loginPhoneRequestCode,
  loginPhoneVerifyCode,
  verifyLoginOtp,
  loginGoogle,
  forgotPassword,
  resetPassword,
  refresh,
  logout,
};