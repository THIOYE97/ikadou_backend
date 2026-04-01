/**
 * Seed script — creates a default super_admin user
 * Run: node src/db/seed.js
 *
 * Default credentials (change immediately after first login):
 *   Email:    admin@ikadou.com
 *   Password: Ikadou@2025!
 */

const bcrypt = require('bcryptjs');
const { pool } = require('../data/db');
const logger = require('../utils/logger');

const seed = async () => {
  const client = await pool.connect();

  try {
    logger.info('🌱 Running seed...');
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash('Ikadou@2025!', 12);

    // Super admin
    await client.query(
      `
      INSERT INTO internal_users (first_name, last_name, email, password_hash, role, status)
      VALUES ('Super', 'Admin', 'admin@ikadou.com', $1, 'super_admin', 'active')
      ON CONFLICT (email) DO NOTHING
      `,
      [passwordHash]
    );

    // Default zones
    const zones = [
      { name: 'Bamako Nord', region: 'Bamako' },
      { name: 'Bamako Sud', region: 'Bamako' },
      { name: 'Bamako Est', region: 'Bamako' },
      { name: 'Bamako Ouest', region: 'Bamako' },
      { name: 'Sikasso', region: 'Sikasso' },
      { name: 'Ségou', region: 'Ségou' },
      { name: 'Mopti', region: 'Mopti' },
      { name: 'Koulikoro', region: 'Koulikoro' },
      { name: 'Kayes', region: 'Kayes' },
      { name: 'Kidal', region: 'Kidal' },
      { name: 'Gao', region: 'Gao' },
      { name: 'Tombouctou', region: 'Tombouctou' },
    ];

    for (const zone of zones) {
      await client.query(
        `
        INSERT INTO zones (name, region)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [zone.name, zone.region]
      );
    }

    // Default notification templates
    const templates = [
      {
        name: 'Bienvenue client',
        type: 'welcome',
        channel: 'email',
        subject: 'Bienvenue sur Ikadou !',
        content:
          'Bonjour {{first_name}}, bienvenue sur la plateforme Ikadou. Votre compte est maintenant actif.',
        variables: JSON.stringify(['first_name', 'last_name']),
      },
      {
        name: 'Confirmation de visite',
        type: 'visit_confirmation',
        channel: 'email',
        subject: 'Votre visite est confirmée — {{terrain_title}}',
        content:
          'Bonjour {{first_name}}, votre visite du terrain {{terrain_title}} est confirmée pour le {{visit_date}} à {{visit_time}}.',
        variables: JSON.stringify(['first_name', 'terrain_title', 'visit_date', 'visit_time']),
      },
      {
        name: 'Rappel de visite SMS',
        type: 'visit_reminder',
        channel: 'sms',
        subject: null,
        content:
          'Rappel Ikadou : votre visite {{terrain_title}} est prévue demain à {{visit_time}}. Contact agent : {{agent_phone}}.',
        variables: JSON.stringify(['terrain_title', 'visit_time', 'agent_phone']),
      },
      {
        name: 'Paiement confirmé',
        type: 'payment_confirmed',
        channel: 'email',
        subject: 'Paiement confirmé — Réf. {{payment_ref}}',
        content:
          'Bonjour {{first_name}}, votre paiement de {{amount}} {{currency}} a bien été reçu. Référence : {{payment_ref}}.',
        variables: JSON.stringify(['first_name', 'amount', 'currency', 'payment_ref']),
      },
    ];

    for (const t of templates) {
      await client.query(
        `
        INSERT INTO notification_templates (name, type, channel, subject, content, variables)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
        `,
        [t.name, t.type, t.channel, t.subject, t.content, t.variables]
      );
    }

    await client.query('COMMIT');
    logger.info('✅ Seed completed!');
    logger.info('👤 Admin: admin@ikadou.com / Ikadou@2025!');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      logger.warn('↩ Seed transaction rolled back');
    } catch (rollbackError) {
      logger.error(`Rollback failed: ${rollbackError.message}`);
    }

    logger.error(`❌ Seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

seed();