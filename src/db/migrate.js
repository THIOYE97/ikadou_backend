const fs = require('fs');
const path = require('path');
const { pool } = require('../data/db');
const logger = require('../utils/logger');

/**
 * Split a SQL file into individual statements.
 * Supports dollar-quoted blocks ($$ ... $$ or $tag$ ... $tag$).
 */
const splitStatements = (sql) => {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();

    if (!inDollarQuote && (trimmed === '' || trimmed.startsWith('--'))) {
      if (current.trim()) current += '\n';
      continue;
    }

    current += line + '\n';

    const matches = line.match(/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/g) || [];
    for (const match of matches) {
      if (!inDollarQuote) {
        inDollarQuote = true;
        dollarTag = match;
      } else if (match === dollarTag) {
        inDollarQuote = false;
        dollarTag = '';
      }
    }

    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt && stmt !== ';') statements.push(stmt);
      current = '';
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements.filter(Boolean);
};

const readSqlFiles = (dirPath) => {
  const preferredOrder = ['schema.sql', 'notification_schema.sql'];

  const existingPreferred = preferredOrder
    .map((file) => path.join(dirPath, file))
    .filter((filePath) => fs.existsSync(filePath));

  const otherSqlFiles = fs
    .readdirSync(dirPath)
    .filter((file) => file.endsWith('.sql') && !preferredOrder.includes(file))
    .sort()
    .map((file) => path.join(dirPath, file));

  return [...existingPreferred, ...otherSqlFiles];
};

const isSkippableError = (err) => {
  return (
    err.code === '42P07' || // relation already exists
    err.code === '42710' || // duplicate object
    err.code === '42701' || // duplicate column
    err.code === '42P06' || // duplicate schema
    err.code === '23505' || // unique violation
    (err.message || '').toLowerCase().includes('already exists')
  );
};

const executeStatements = async (client, statements, fileLabel) => {
  logger.info(`📄 ${fileLabel}: ${statements.length} statement(s)`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 100);
    const savepoint = `sp_${Date.now()}_${i}`;

    await client.query(`SAVEPOINT ${savepoint}`);

    try {
      await client.query(stmt);
      logger.info(`  [${i + 1}/${statements.length}] ✓ ${preview}${preview.length >= 100 ? '…' : ''}`);
    } catch (err) {
      if (isSkippableError(err)) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        logger.warn(`  [${i + 1}/${statements.length}] ⚠ skipped: ${preview}${preview.length >= 100 ? '…' : ''}`);
      } else {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        logger.error(`  [${i + 1}/${statements.length}] ✗ FAILED`);
        logger.error(`  code: ${err.code || '—'}`);
        logger.error(`  message: ${err.message || '—'}`);
        logger.error(`  detail: ${err.detail || '—'}`);
        logger.error(`  hint: ${err.hint || '—'}`);
        logger.error(`  file: ${fileLabel}`);
        throw err;
      }
    } finally {
      try {
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (_) {
        // ignore if already rolled back/released
      }
    }
  }
};

const migrate = async () => {
  const client = await pool.connect();

  try {
    logger.info('🚀 Starting database migration...');

    const dbDir = __dirname;
    const sqlFiles = readSqlFiles(dbDir);

    if (!sqlFiles.length) {
      logger.warn('⚠ No SQL files found. Nothing to migrate.');
      return;
    }

    logger.info(`📚 SQL files detected: ${sqlFiles.map((f) => path.basename(f)).join(', ')}`);

    await client.query('BEGIN');

    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    for (const filePath of sqlFiles) {
      const fileName = path.basename(filePath);
      const sql = fs.readFileSync(filePath, 'utf-8');
      const statements = splitStatements(sql);

      if (!statements.length) {
        logger.warn(`⚠ ${fileName}: no executable statements found`);
        continue;
      }

      await executeStatements(client, statements, fileName);
    }

    await client.query('COMMIT');
    logger.info('✅ Migration completed successfully!');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      logger.warn('↩ Transaction rolled back');
    } catch (rollbackError) {
      logger.error(`Rollback failed: ${rollbackError.message}`);
    }

    logger.error('❌ Migration failed!');
    logger.error(`code: ${error.code || '—'}`);
    logger.error(`message: ${error.message || '—'}`);
    logger.error(`detail: ${error.detail || '—'}`);
    logger.error(`hint: ${error.hint || '—'}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();