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

const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim().toLowerCase();

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
 * Ownership/permission mismatch can happen in dev when an object already exists
 * but was created by another DB owner.
 *
 * We only tolerate it for explicitly idempotent schema evolution statements.
 */
const isOwnershipSkippable = (err, stmt) => {
  if (err.code !== '42501') return false;

  const sql = normalizeSql(stmt);

  const safePatterns = [
    /^create table if not exists /,
    /^create index if not exists /,
    /^alter table .* add column if not exists /,
    /^alter table .* alter column .* set default /,
    /^alter table .* add constraint /,
  ];

  return safePatterns.some((pattern) => pattern.test(sql));
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

  const statements = splitStatements(sql).filter((stmt) => {
    const normalized = normalizeSql(stmt).replace(/;$/, '');
    return !['begin', 'commit', 'rollback'].includes(normalized);
  });

  logger.info(`📄 ${path.basename(filePath)} — ${statements.length} statements`);

  await client.query('BEGIN');

  try {
    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i];
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 160);

      try {
        await client.query('SAVEPOINT migration_stmt');
        await client.query(stmt);
        await client.query('RELEASE SAVEPOINT migration_stmt');
        logger.debug(`   [${i + 1}/${statements.length}] ✓ ${preview}…`);
      } catch (err) {
        try {
          await client.query('ROLLBACK TO SAVEPOINT migration_stmt');
        } catch (_) {}

        try {
          await client.query('RELEASE SAVEPOINT migration_stmt');
        } catch (_) {}

        if (isIgnorableMigrationError(err)) {
          logger.warn(`   [${i + 1}/${statements.length}] ⚠ skipped (already exists): ${preview}…`);
          continue;
        }

        if (isOwnershipSkippable(err, stmt)) {
          logger.warn(`   [${i + 1}/${statements.length}] ⚠ skipped (ownership mismatch): ${preview}…`);
          logger.warn(`      reason: ${err.message}`);
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

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  }
};

const collectExtraMigrations = (dirPath) => {
  if (!fs.existsSync(dirPath)) return [];

  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(dirPath, name));
};

const migrate = async () => {
  const client = await pool.connect();

  try {
    logger.info('🚀 Starting database migration...');

    const whoami = await client.query(
      `SELECT current_user, current_database(), current_schema()`
    );
    logger.info(
      `👤 DB user=${whoami.rows[0].current_user} db=${whoami.rows[0].current_database} schema=${whoami.rows[0].current_schema}`
    );

    /**
     * Order matters:
     * 1. base schema
     * 2. payment extension
     * 3. notification extension
     * 4. mobile/client app extension
     * 5. support + payment proofs
     */
    const baseSchemas = [
      path.join(__dirname, 'schema.sql'),
      path.join(__dirname, 'payment_schema.sql'),
      path.join(__dirname, 'notification_schema.sql'),
      path.join(__dirname, 'client_app_schema.sql'),
      path.join(__dirname, '20260413_support_client_and_payment_proofs.sql'),
      path.join(__dirname, 'long_lat.sql'),
      path.join(__dirname, 'leads.sql'),
      path.join(__dirname, '20260421_client_projects.sql'),
      path.join(__dirname, 'payment_sql.sql'),
      path.join(__dirname, 'terrain1.sql'),
      path.join(__dirname, 'login.sql'),
      path.join(__dirname, 'login_2.sql'),
    ];

    const extraMigrations = collectExtraMigrations(path.join(__dirname, 'migrations'));
    const schemas = [...baseSchemas, ...extraMigrations];

    logger.info(`📚 ${schemas.length} migration file(s) to process`);

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