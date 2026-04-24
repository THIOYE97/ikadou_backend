const jwt = require('jsonwebtoken');
const config = require('../config/env');

const CLIENT_ACCESS_TOKEN_TTL = process.env.CLIENT_ACCESS_TOKEN_TTL || '30d';

function signClientAccessToken(client) {
  if (!client?.id) {
    throw new Error('Client id is required to sign access token');
  }

  return jwt.sign(
    {
      clientId: client.id,
      id: client.id,
      role: 'client',
      email: client.email || null,
      phone: client.phone || null,
      status: client.status || 'active',
    },
    config.jwtSecret,
    {
      expiresIn: CLIENT_ACCESS_TOKEN_TTL,
    }
  );
}

module.exports = {
  signClientAccessToken,
};
