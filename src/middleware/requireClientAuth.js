const jwt = require('jsonwebtoken');
const { query } = require('../data/db');
const HttpError = require('../utils/httpError');
const config = require('../config/env');

async function requireClientAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      throw HttpError.unauthorized('Missing or invalid authorization header');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw HttpError.unauthorized('Missing or invalid authorization header');
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (_) {
      throw HttpError.unauthorized('Invalid or expired token');
    }

    const clientId =
      payload.clientId ||
      payload.client_id ||
      payload.sub ||
      payload.id;

    if (!clientId) {
      throw HttpError.unauthorized('Invalid token payload');
    }

    const result = await query(
      `SELECT
         c.*,
         caa.id                   AS auth_account_id,
         caa.email                AS auth_email,
         caa.phone                AS auth_phone,
         caa.is_email_verified,
         caa.is_phone_verified,
         caa.is_active            AS auth_is_active,
         caa.google_sub,
         caa.google_email,
         caa.auth_methods,
         caa.preferred_login,
         caa.preferred_otp_channel,
         caa.last_login_at,
         caa.last_strong_verified_at,
         caa.last_login_method
       FROM clients c
       LEFT JOIN client_auth_accounts caa
         ON caa.client_id = c.id
       WHERE c.id = $1
       LIMIT 1`,
      [clientId]
    );

    if (!result.rows.length) {
      throw HttpError.unauthorized('Client not found');
    }

    const row = result.rows[0];

    if (row.status !== 'active') {
      throw HttpError.unauthorized('Client account is suspended or inactive');
    }

    if (!row.auth_account_id) {
      throw HttpError.unauthorized('Client auth account not found');
    }

    if (!row.auth_is_active) {
      throw HttpError.unauthorized('Client auth account is inactive');
    }

    req.client = {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
      country: row.country,
      city: row.city,
      status: row.status,
      push_token: row.push_token,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    req.clientAuth = payload;

    req.clientAuthAccount = {
      id: row.auth_account_id,
      email: row.auth_email,
      phone: row.auth_phone,
      is_email_verified: row.is_email_verified,
      is_phone_verified: row.is_phone_verified,
      is_active: row.auth_is_active,
      google_sub: row.google_sub,
      google_email: row.google_email,
      auth_methods: row.auth_methods,
      preferred_login: row.preferred_login,
      preferred_otp_channel: row.preferred_otp_channel,
      last_login_at: row.last_login_at,
      last_strong_verified_at: row.last_strong_verified_at,
      last_login_method: row.last_login_method,
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = requireClientAuth;