const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const { pool } = require('./data/db');


const server = app.listen(config.port, '0.0.0.0' , () => {
  logger.info(`
  ╔════════════════════════════════════════╗
  ║        🌍  IKADOU BACKEND API          ║
  ╠════════════════════════════════════════╣
  ║  ENV:  ${config.env.padEnd(32)}║
  ║  PORT: ${String(config.port).padEnd(32)}║
  ╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    logger.info('PostgreSQL pool closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

module.exports = server;
