const nodemailer  = require('nodemailer');
const Handlebars  = require('handlebars');
const config      = require('../config/env');
const logger      = require('../utils/logger');

// ─── Singleton transporter ────────────────────────────────

let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.secure,
    auth:   { user: config.email.user, pass: config.email.pass },
    tls:    { rejectUnauthorized: false },
  });
  return _transporter;
};

// ─── Base HTML layout ─────────────────────────────────────

const BASE_HTML = `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
body{margin:0;padding:0;background:#f5f0ea;font-family:'Helvetica Neue',Arial,sans-serif}
.wrap{max-width:600px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
.hdr{background:#1c1208;padding:24px 36px}
.logo{color:#dc7a20;font-size:24px;font-weight:700;text-decoration:none}
.tag{color:rgba(255,255,255,.35);font-size:11px;margin-top:3px}
.body{padding:36px;color:#2d2416;font-size:15px;line-height:1.75}
.hi{font-size:18px;font-weight:600;margin-bottom:16px}
.box{background:#fdf7ee;border-left:4px solid #dc7a20;border-radius:6px;padding:16px 20px;margin:20px 0;font-size:14px}
.btn{display:inline-block;margin:20px 0;padding:13px 30px;background:#dc7a20;color:#fff!important;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}
.info{font-size:13px;color:#9e8a6a;border-top:1px solid #f0e8dc;padding-top:16px;margin-top:24px}
.ftr{background:#fdf7ee;padding:20px 36px;text-align:center;font-size:12px;color:#9e8a6a}
.ftr a{color:#dc7a20;text-decoration:none}
</style></head>
<body><div class="wrap">
<div class="hdr"><div class="logo">🌍 Ikadou</div><div class="tag">Investir au Mali, en toute sérénité</div></div>
<div class="body">{{{body}}}</div>
<div class="ftr"><p>© {{year}} Ikadou &nbsp;·&nbsp; <a href="#">Se désabonner</a> &nbsp;·&nbsp; <a href="#">Confidentialité</a></p>
<p>Email automatique — merci de ne pas répondre directement.</p></div>
</div></body></html>`;

// ─── Built-in template library ────────────────────────────

const TEMPLATES = {
  welcome: (v) => ({
    subject: `Bienvenue sur Ikadou, ${v.first_name} !`,
    html: `<div class="hi">Bonjour {{first_name}} 👋</div>
<p>Votre compte Ikadou est maintenant actif. Nous sommes ravis de vous accueillir sur la plateforme de référence pour l'investissement immobilier au Mali.</p>
<div class="box">🏡 Découvrez nos terrains sécurisés et commencez votre projet immobilier dès aujourd'hui.</div>
<p><a href="{{app_url}}" class="btn">Explorer les terrains</a></p>
<p class="info">Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.</p>`,
  }),

  visit_confirmation: (v) => ({
    subject: `Visite confirmée — {{terrain_title}}`,
    html: `<div class="hi">Votre visite est confirmée ✅</div>
<p>Bonjour {{first_name}},</p>
<p>Votre visite du terrain <strong>{{terrain_title}}</strong> est bien enregistrée.</p>
<div class="box">
  📅 <strong>Date :</strong> {{visit_date}}<br>
  🕐 <strong>Heure :</strong> {{visit_time}}<br>
  👤 <strong>Agent :</strong> {{agent_name}}<br>
  📞 <strong>Contact :</strong> {{agent_phone}}
</div>
<p>Pensez à vous munir d'une pièce d'identité pour la visite.</p>
<p class="info">Des questions ? Contactez notre équipe via l'application Ikadou.</p>`,
  }),

  visit_reminder: (v) => ({
    subject: `Rappel : votre visite demain — {{terrain_title}}`,
    html: `<div class="hi">Rappel de visite 🔔</div>
<p>Bonjour {{first_name}},</p>
<p>Nous vous rappelons votre visite <strong>demain</strong> pour le terrain <strong>{{terrain_title}}</strong>.</p>
<div class="box">
  📅 <strong>Demain à {{visit_time}}</strong><br>
  👤 Agent : {{agent_name}} — {{agent_phone}}
</div>`,
  }),

  visit_cancelled: (v) => ({
    subject: `Visite annulée — {{terrain_title}}`,
    html: `<div class="hi">Visite annulée</div>
<p>Bonjour {{first_name}},</p>
<p>Votre visite du terrain <strong>{{terrain_title}}</strong> prévue le {{visit_date}} à {{visit_time}} a été annulée.</p>
<p>{{#if cancel_reason}}<em>Motif : {{cancel_reason}}</em><br>{{/if}}</p>
<p><a href="{{app_url}}" class="btn">Planifier une nouvelle visite</a></p>`,
  }),

  visit_rescheduled: (v) => ({
    subject: `Visite replanifiée — {{terrain_title}}`,
    html: `<div class="hi">Votre visite a été replanifiée 📅</div>
<p>Bonjour {{first_name}},</p>
<p>Votre visite du terrain <strong>{{terrain_title}}</strong> a été déplacée.</p>
<div class="box">
  📅 <strong>Nouvelle date :</strong> {{new_date}}<br>
  🕐 <strong>Nouvelle heure :</strong> {{new_time}}<br>
  👤 <strong>Agent :</strong> {{agent_name}} — {{agent_phone}}
</div>`,
  }),

  payment_confirmed: (v) => ({
    subject: `Paiement confirmé — Réf. {{payment_ref}}`,
    html: `<div class="hi">Paiement reçu ✅</div>
<p>Bonjour {{first_name}},</p>
<p>Votre paiement a bien été reçu et confirmé.</p>
<div class="box">
  💳 <strong>Référence :</strong> {{payment_ref}}<br>
  💰 <strong>Montant :</strong> {{amount}} {{currency}}<br>
  📅 <strong>Date :</strong> {{payment_date}}<br>
  🏡 <strong>Terrain :</strong> {{terrain_title}}
</div>
<p class="info">Conservez cet email comme preuve de votre paiement.</p>`,
  }),

  payment_pending: (v) => ({
    subject: `Paiement en attente — {{payment_ref}}`,
    html: `<div class="hi">Paiement en attente de validation</div>
<p>Bonjour {{first_name}},</p>
<p>Votre paiement <strong>{{payment_ref}}</strong> de <strong>{{amount}} {{currency}}</strong> est en cours de traitement.</p>
<p>Vous recevrez une confirmation dès validation par notre équipe.</p>`,
  }),

  payment_failed: (v) => ({
    subject: `Paiement échoué — Action requise`,
    html: `<div class="hi">Votre paiement n'a pas abouti ⚠️</div>
<p>Bonjour {{first_name}},</p>
<p>Votre paiement <strong>{{payment_ref}}</strong> de <strong>{{amount}} {{currency}}</strong> a échoué.</p>
<p>Veuillez contacter notre équipe ou réessayer via l'application.</p>
<p><a href="{{app_url}}" class="btn">Contacter le support</a></p>`,
  }),

  lead_assigned: (v) => ({
    subject: `Un agent vous a été assigné — Ikadou`,
    html: `<div class="hi">Votre dossier a été pris en charge 👤</div>
<p>Bonjour {{first_name}},</p>
<p>Un agent dédié a été assigné à votre dossier. Il prendra contact avec vous dans les plus brefs délais.</p>
<div class="box">
  👤 <strong>Votre agent :</strong> {{agent_name}}<br>
  📞 <strong>Téléphone :</strong> {{agent_phone}}
</div>`,
  }),

  ticket_opened: (v) => ({
    subject: `Ticket support créé — Réf. {{ticket_ref}}`,
    html: `<div class="hi">Votre demande a été enregistrée ✅</div>
<p>Bonjour {{first_name}},</p>
<p>Votre demande de support a été prise en compte.</p>
<div class="box">
  🎫 <strong>Référence :</strong> {{ticket_ref}}<br>
  📋 <strong>Sujet :</strong> {{subject}}<br>
  🔴 <strong>Priorité :</strong> {{priority}}
</div>
<p>Notre équipe traitera votre demande dans les meilleurs délais.</p>`,
  }),

  ticket_resolved: (v) => ({
    subject: `Votre demande a été résolue — {{ticket_ref}}`,
    html: `<div class="hi">Demande résolue ✅</div>
<p>Bonjour {{first_name}},</p>
<p>Votre demande <strong>{{ticket_ref}}</strong> concernant "<em>{{subject}}</em>" a été résolue.</p>
<p>Si le problème persiste, n'hésitez pas à rouvrir un ticket.</p>`,
  }),

  account_suspended: (v) => ({
    subject: `Votre compte Ikadou a été suspendu`,
    html: `<div class="hi">Compte suspendu</div>
<p>Bonjour {{first_name}},</p>
<p>Votre compte Ikadou a été temporairement suspendu. Veuillez contacter notre support pour plus d'informations.</p>`,
  }),

  account_reactivated: (v) => ({
    subject: `Votre compte Ikadou est réactivé 🎉`,
    html: `<div class="hi">Compte réactivé ✅</div>
<p>Bonjour {{first_name}},</p>
<p>Bonne nouvelle ! Votre compte Ikadou est de nouveau actif. Vous pouvez reprendre vos activités normalement.</p>
<p><a href="{{app_url}}" class="btn">Accéder à mon espace</a></p>`,
  }),

  password_reset: (v) => ({
    subject: `Réinitialisation de votre mot de passe`,
    html: `<div class="hi">Demande de réinitialisation</div>
<p>Bonjour,</p>
<p>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le lien ci-dessous (valable 1 heure) :</p>
<p><a href="{{reset_url}}" class="btn">Réinitialiser mon mot de passe</a></p>
<p class="info">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`,
  }),

  // Custom / DB template
  custom: (v) => ({ subject: v.subject || 'Message Ikadou', html: v.body || '' }),
};

// ─── Interpolation helper ─────────────────────────────────

const interpolate = (str, vars = {}) => {
  if (!str) return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{{${key}}}`);
};

// ─── Send function ────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  opts.to
 * @param {string}  opts.subject     - override subject
 * @param {string}  opts.html        - raw HTML (already rendered) OR templateContent from DB
 * @param {string}  [opts.type]      - built-in template key
 * @param {object}  [opts.vars]      - interpolation variables
 */
const sendEmail = async ({ to, subject, html, type, vars = {} }) => {
  if (!config.notifications.emailEnabled) {
    logger.info(`[Email] Disabled — skip ${to}`);
    return { messageId: 'disabled', skipped: true };
  }
  if (!config.email.user) {
    logger.warn('[Email] SMTP not configured');
    return { messageId: 'unconfigured', skipped: true };
  }

  let resolvedSubject = subject;
  let resolvedHtml    = html;

  // Use built-in template if type provided and no raw html
  if (type && TEMPLATES[type] && !html) {
    const tpl = TEMPLATES[type](vars);
    resolvedSubject = resolvedSubject || tpl.subject;
    resolvedHtml    = tpl.html;
  }

  // Interpolate variables into subject and content
  resolvedSubject = interpolate(resolvedSubject, vars);
  const bodyHtml  = interpolate(resolvedHtml || '', vars);

  // Wrap in base layout
  const layoutTpl = Handlebars.compile(BASE_HTML);
  const finalHtml = layoutTpl({
    body: bodyHtml,
    year: new Date().getFullYear(),
    ...vars,
  });

  const info = await getTransporter().sendMail({
    from:    `"${config.email.fromName}" <${config.email.fromEmail}>`,
    to,
    subject: resolvedSubject,
    html:    finalHtml,
  });

  logger.info(`[Email] Sent to ${to} — ${info.messageId}`);
  return { messageId: info.messageId };
};

const verifyConnection = async () => {
  try {
    await getTransporter().verify();
    logger.info('[Email] SMTP verified ✓');
    return true;
  } catch (err) {
    logger.warn(`[Email] SMTP error: ${err.message}`);
    return false;
  }
};

module.exports = { sendEmail, verifyConnection, interpolate, TEMPLATES };