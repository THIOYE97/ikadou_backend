const fs   = require('fs');
const path = require('path');
const { pool } = require('../data/db');
const logger = require('../utils/logger');

/**
 * Split SQL into individual statements, handling $$ dollar-quoted blocks.
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
    for (const m of matches) {
      if (!inDollarQuote) { inDollarQuote = true; dollarTag = m; }
      else if (m === dollarTag) { inDollarQuote = false; dollarTag = ''; }
    }
    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt && stmt !== ';') statements.push(stmt);
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter(Boolean);
};

/**
 * Execute a single SQL file against the database.
 * Tolerates "already exists" errors (idempotent).
 */
const runFile = async (client, filePath) => {
  if (!fs.existsSync(filePath)) {
    logger.warn(`Migration file not found, skipping: ${path.basename(filePath)}`);
    return;
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  const statements = splitStatements(sql);
  logger.info(`  📄 ${path.basename(filePath)} — ${statements.length} statements`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.replace(/\s+/g, ' ').substring(0, 80);
    try {
      await client.query(stmt);
      logger.debug(`    [${i + 1}/${statements.length}] ✓ ${preview}…`);
    } catch (err) {
      const isAlreadyExists =
        err.code === '42P07' || // relation already exists
        err.code === '42710' || // duplicate object (type, index…)
        err.code === '42701' || // duplicate column
        err.code === '23505' || // unique violation
        (err.message || '').toLowerCase().includes('already exists');

      if (isAlreadyExists) {
        logger.warn(`    [${i + 1}/${statements.length}] ⚠ skipped (already exists): ${preview}…`);
      } else {
        logger.error(`    [${i + 1}/${statements.length}] ✗ FAILED`);
        logger.error(`    code: ${err.code}  msg: ${err.message}`);
        logger.error(`    detail: ${err.detail || '—'}  hint: ${err.hint || '—'}`);
        throw err;
      }
    }
  }
};

const migrate = async () => {
  const client = await pool.connect();
  try {
    logger.info('🚀 Starting database migration…');

    // Order matters — run base schema first, then extensions
    const schemas = [
      path.join(__dirname, 'schema.sql'),
      path.join(__dirname, 'payment_schema.sql'),
      path.join(__dirname, 'notification_schema.sql'),
    ];

    for (const schemaPath of schemas) {
      await runFile(client, schemaPath);
    }

    logger.info('✅ All migrations completed successfully!');
  } catch (error) {
    logger.error('❌ Migration failed!');
    logger.error(`code: ${error.code}  message: ${error.message}`);
    logger.error(`detail: ${error.detail || '—'}  hint: ${error.hint || '—'}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();