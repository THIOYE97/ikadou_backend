const logger = require('../utils/logger');
const HttpError = require('../utils/httpError');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // Log the error
  if (err.statusCode >= 500 || !err.statusCode) {
    logger.error(`[${req.method}] ${req.path} — ${err.message}`, {
      stack: err.stack,
      body: req.body,
    });
  } else {
    logger.warn(`[${req.method}] ${req.path} — ${err.message}`);
  }

  // Validation errors from express-validator
  if (err.type === 'validation') {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: err.errors,
    });
  }

  // Known HttpError
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  // PostgreSQL unique constraint
  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'A record with this information already exists',
    });
  }

  // PostgreSQL FK violation
  if (err.code === '23503') {
    return res.status(400).json({
      success: false,
      message: 'Referenced record does not exist',
    });
  }

  // Default 500
  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
