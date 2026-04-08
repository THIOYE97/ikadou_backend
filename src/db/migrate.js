const fs = require('fs');
const path = require('path');
const { pool } = require('../data/db');
const logger = require('../utils/logger');

/**
 * Split SQL into executable statements.
 * Handles:
 * - line comments
 * - empty lines
 * - $$ or $tag$ dollar-quoted PostgreSQL blocks
 */
const splitStatements = (sql) => {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();

    // Ignore pure comments / empty lines only when we're not inside a dollar block
    if (!inDollarQuote && (trimmed.startsWith('--') || trimmed === '')) {
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

/**
 * Returns true if an error should be tolerated because the migration is idempotent.
 */
const isIgnorableMigrationError = (err) => {
  const msg = (err.message || '').toLowerCase();

  return (
    err.code === '42P07' || // relation already exists
    err.code === '42710' || // duplicate_object
    err.code === '42701' || // duplicate_column
    err.code === '23505' || // unique_violation
    msg.includes('already exists')
  );
};

/**
 * Execute one SQL file statement by statement.
 */
const runFile = async (client, filePath) => {
  if (!fs.existsSync(filePath)) {
    logger.warn(`Migration file not found, skipping: ${path.basename(filePath)}`);
    return;
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const statements = splitStatements(sql);

  logger.info(`📄 ${path.basename(filePath)} — ${statements.length} statements`);

  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i];
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 120);

    try {
      await client.query(stmt);
      logger.debug(`   [${i + 1}/${statements.length}] ✓ ${preview}…`);
    } catch (err) {
      if (isIgnorableMigrationError(err)) {
        logger.warn(`   [${i + 1}/${statements.length}] ⚠ skipped (already exists): ${preview}…`);
        continue;
      }

      logger.error(`   [${i + 1}/${statements.length}] ✗ FAILED`);
      logger.error(`   file: ${path.basename(filePath)}`);
      logger.error(`   code: ${err.code || '—'}`);
      logger.error(`   message: ${err.message || '—'}`);
      logger.error(`   detail: ${err.detail || '—'}`);
      logger.error(`   hint: ${err.hint || '—'}`);
      throw err;
    }
  }
};

const migrate = async () => {
  const client = await pool.connect();

  try {
    logger.info('🚀 Starting database migration...');

    /**
     * Order matters:
     * 1. base schema
     * 2. payment extension
     * 3. notification extension
     * 4. mobile/client app extension
     */
    const schemas = [
      path.join(__dirname, 'schema.sql'),
      path.join(__dirname, 'payment_schema.sql'),
      path.join(__dirname, 'notification_schema.sql'),
      path.join(__dirname, 'client_app_schema.sql'),
    ];

    for (const schemaPath of schemas) {
      await runFile(client, schemaPath);
    }

    logger.info('✅ All migrations completed successfully!');
  } catch (error) {
    logger.error('❌ Migration failed!');
    logger.error(`code: ${error.code || '—'}`);
    logger.error(`message: ${error.message || '—'}`);
    logger.error(`detail: ${error.detail || '—'}`);
    logger.error(`hint: ${error.hint || '—'}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();