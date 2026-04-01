const { Pool } = require('pg');
const config = require('../config/env');
const logger = require('../utils/logger');

const pool = new Pool(config.db);

pool.on('connect', () => {
  logger.info('📦 New PostgreSQL connection established');
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', err);
  process.exit(-1);
});

/**
 * Execute a single query
 */
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug('Executed query', { text, duration, rows: res.rowCount });
  return res;
};

/**
 * Get a client for transactions
 */
const getClient = () => pool.connect();

/**
 * Run a transaction with automatic rollback on error
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, transaction, pool };
