const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.CLIENT_JWT_SECRET || process.env.JWT_SECRET || 'change-me-client-secret';
const ACCESS_EXPIRES_IN = process.env.CLIENT_JWT_EXPIRES_IN || '7d';

const signClientAccessToken = (client) => {
  return jwt.sign(
    {
      sub: client.id,
      type: 'client_access',
      role: 'client',
    },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
};

const verifyClientAccessToken = (token) => {
  return jwt.verify(token, ACCESS_SECRET);
};

module.exports = {
  signClientAccessToken,
  verifyClientAccessToken,
};