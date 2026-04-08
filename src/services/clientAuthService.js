const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const otpService = require('./otpService');
const { signClientAccessToken } = require('../utils/clientJwt');

const REFRESH_TOKEN_TTL_DAYS = Number(process.env.CLIENT_REFRESH_TOKEN_TTL_DAYS || 30);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

const randomToken = () => crypto.randomBytes(48).toString('hex');

const normalizeEmail = (value) => value ? String(value).trim().toLowerCase() : null;
const normalizePhone = (value) => value ? String(value).trim() : null;

const findClientByEmailOrPhone = async ({ email, phone }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const result = await query(
    `SELECT *
     FROM clients
     WHERE ($1::varchar IS NOT NULL AND LOWER(email) = $1)
        OR ($2::varchar IS NOT NULL AND phone = $2)
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalizedEmail, normalizedPhone]
  );

  return result.rows[0] || null;
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

const upsertClientAuthAccount = async ({ clientId, email, phone, passwordHash }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const existing = await query(
    `SELECT * FROM client_auth_accounts WHERE client_id = $1`,
    [clientId]
  );

  if (existing.rows.length) {
    const updated = await query(
      `UPDATE client_auth_accounts
       SET email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           password_hash = COALESCE($4, password_hash),
           updated_at = NOW()
       WHERE client_id = $1
       RETURNING *`,
      [clientId, normalizedEmail, normalizedPhone, passwordHash || null]
    );
    return updated.rows[0];
  }

  const inserted = await query(
    `INSERT INTO client_auth_accounts
      (client_id, email, phone, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [clientId, normalizedEmail, normalizedPhone, passwordHash]
  );

  return inserted.rows[0];
};

const createRefreshToken = async (clientId) => {
  const token = randomToken();

  await query(
    `INSERT INTO client_refresh_tokens (client_id, token, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
    [clientId, token, String(REFRESH_TOKEN_TTL_DAYS)]
  );

  return token;
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

const registerInit = async ({ firstName, lastName, email, phone, password, country, city }) => {
  if (!email || !phone) {
    throw HttpError.badRequest('Email et téléphone sont requis pour l’inscription');
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const existingByAuth = await query(
    `SELECT caa.*, c.status AS client_status
     FROM client_auth_accounts caa
     JOIN clients c ON c.id = caa.client_id
     WHERE LOWER(caa.email) = $1 OR caa.phone = $2
     LIMIT 1`,
    [normalizedEmail, normalizedPhone]
  );

  if (existingByAuth.rows.length) {
    throw HttpError.conflict('Un compte existe déjà avec cet email ou ce téléphone');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let client = await findClientByEmailOrPhone({ email: normalizedEmail, phone: normalizedPhone });

  if (!client) {
    const inserted = await query(
      `INSERT INTO clients (first_name, last_name, email, phone, country, city)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [firstName, lastName, normalizedEmail, normalizedPhone, country || null, city || null]
    );
    client = inserted.rows[0];
  } else {
    const updated = await query(
      `UPDATE clients
       SET first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           email = COALESCE($4, email),
           phone = COALESCE($5, phone),
           country = COALESCE($6, country),
           city = COALESCE($7, city)
       WHERE id = $1
       RETURNING *`,
      [client.id, firstName, lastName, normalizedEmail, normalizedPhone, country || null, city || null]
    );
    client = updated.rows[0];
  }

  const account = await upsertClientAuthAccount({
    clientId: client.id,
    email: normalizedEmail,
    phone: normalizedPhone,
    passwordHash,
  });

  await linkLeadToClient({ clientId: client.id, email: normalizedEmail, phone: normalizedPhone });

  const emailOtp = await otpService.createOtp({
    clientId: client.id,
    accountId: account.id,
    target: normalizedEmail,
    channel: 'email',
    purpose: 'signup_email',
  });

  const phoneOtp = await otpService.createOtp({
    clientId: client.id,
    accountId: account.id,
    target: normalizedPhone,
    channel: 'sms',
    purpose: 'signup_phone',
  });

  await otpService.sendOtp({
    target: normalizedEmail,
    channel: 'email',
    code: emailOtp.rawCode,
    purpose: 'signup_email',
  });

  await otpService.sendOtp({
    target: normalizedPhone,
    channel: 'sms',
    code: phoneOtp.rawCode,
    purpose: 'signup_phone',
  });

  return {
    clientId: client.id,
    requires: ['email_otp', 'phone_otp'],
  };
};

const registerVerify = async ({ email, phone, emailCode, phoneCode }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const emailCheck = await otpService.verifyOtp({
    target: normalizedEmail,
    purpose: 'signup_email',
    code: emailCode,
  });

  if (!emailCheck.ok) {
    throw HttpError.badRequest(
      emailCheck.reason === 'expired'
        ? 'Le code email a expiré'
        : 'Le code email est invalide'
    );
  }

  const phoneCheck = await otpService.verifyOtp({
    target: normalizedPhone,
    purpose: 'signup_phone',
    code: phoneCode,
  });

  if (!phoneCheck.ok) {
    throw HttpError.badRequest(
      phoneCheck.reason === 'expired'
        ? 'Le code téléphone a expiré'
        : 'Le code téléphone est invalide'
    );
  }

  const accountRes = await query(
    `UPDATE client_auth_accounts
     SET is_email_verified = TRUE,
         is_phone_verified = TRUE,
         is_active = TRUE,
         updated_at = NOW()
     WHERE LOWER(email) = $1 AND phone = $2
     RETURNING *`,
    [normalizedEmail, normalizedPhone]
  );

  if (!accountRes.rows.length) {
    throw HttpError.notFound('Compte client introuvable');
  }

  const account = accountRes.rows[0];

  const clientRes = await query(
    `SELECT * FROM clients WHERE id = $1`,
    [account.client_id]
  );

  const client = clientRes.rows[0];
  const accessToken = signClientAccessToken(client);
  const refreshToken = await createRefreshToken(client.id);

  await query(
    `UPDATE client_auth_accounts
     SET last_login_at = NOW()
     WHERE id = $1`,
    [account.id]
  );

  return {
    client,
    accessToken,
    refreshToken,
  };
};

const login = async ({ login, password }) => {
  const normalizedEmail = normalizeEmail(login);
  const normalizedPhone = normalizePhone(login);

  const result = await query(
    `SELECT caa.*, c.*
     FROM client_auth_accounts caa
     JOIN clients c ON c.id = caa.client_id
     WHERE LOWER(caa.email) = $1 OR caa.phone = $2
     LIMIT 1`,
    [normalizedEmail, normalizedPhone]
  );

  if (!result.rows.length) {
    throw HttpError.forbidden('Identifiants invalides');
  }

  const row = result.rows[0];

  if (!row.is_active || row.status !== 'active') {
    throw HttpError.forbidden('Compte indisponible');
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    throw HttpError.forbidden('Identifiants invalides');
  }

  const client = {
    id: row.client_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
  };

  const accessToken = signClientAccessToken(client);
  const refreshToken = await createRefreshToken(client.id);

  await query(
    `UPDATE client_auth_accounts
     SET last_login_at = NOW()
     WHERE id = $1`,
    [row.id]
  );

  return { client, accessToken, refreshToken };
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

  const accessToken = signClientAccessToken(client);
  return { client, accessToken };
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
  registerInit,
  registerVerify,
  login,
  refresh,
  logout,
};