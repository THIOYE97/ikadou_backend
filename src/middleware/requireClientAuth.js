const HttpError = require('../utils/httpError');
const { query } = require('../data/db');
const { verifyClientAccessToken } = require('../utils/clientJwt');

const requireClientAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw HttpError.forbidden('Authentification client requise');
    }

    let payload;
    try {
      payload = verifyClientAccessToken(token);
    } catch (err) {
      throw HttpError.forbidden('Token client invalide ou expiré');
    }

    if (payload.type !== 'client_access' || !payload.sub) {
      throw HttpError.forbidden('Token client invalide');
    }

    const result = await query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.status,
              caa.is_active
       FROM clients c
       LEFT JOIN client_auth_accounts caa ON caa.client_id = c.id
       WHERE c.id = $1`,
      [payload.sub]
    );

    if (!result.rows.length) {
      throw HttpError.forbidden('Client introuvable');
    }

    const client = result.rows[0];

    if (client.status !== 'active') {
      throw HttpError.forbidden('Compte client inactif');
    }

    if (client.is_active === false) {
      throw HttpError.forbidden('Accès client désactivé');
    }

    req.client = client;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireClientAuth;