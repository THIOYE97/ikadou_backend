const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

const SALT_ROUNDS = 12;

/**
 * Hash a password
 */
const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

/**
 * Compare password with hash
 */
const comparePassword = (password, hash) => bcrypt.compare(password, hash);

/**
 * Generate access token
 */
const generateAccessToken = (payload) =>
  jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

/**
 * Generate refresh token
 */
const generateRefreshToken = (payload) =>
  jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  });

/**
 * Verify access token
 */
const verifyAccessToken = (token) => jwt.verify(token, config.jwt.secret);

/**
 * Verify refresh token
 */
const verifyRefreshToken = (token) =>
  jwt.verify(token, config.jwt.refreshSecret);

/**
 * Generate a random opaque token for refresh token storage
 */
const generateOpaqueToken = () => uuidv4() + '-' + uuidv4();

/**
 * Build token pair for a user
 */
const buildTokenPair = (user) => {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
};

module.exports = {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateOpaqueToken,
  buildTokenPair,
};
