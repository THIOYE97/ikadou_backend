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

const TEMPLATES = {
  welcome: () => ({
    subject: `Bienvenue sur Ikadou, {{first_name}} !`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Bienvenue sur Ikadou</h1>
  <p class="subtitle">Votre compte est actif. Votre parcours immobilier peut commencer.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Nous sommes ravis de vous accueillir sur Ikadou, votre plateforme pour investir au Mali en toute sérénité.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Statut</span><br><span class="value">Compte activé</span></div>
    <div class="row"><span class="label">Disponible</span><br><span class="value">Terrains · Visites · Paiements · Support</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn">Explorer les terrains</a></p>
  <p class="info">Si vous n’êtes pas à l’origine de cette inscription, ignorez cet email.</p>
</div>`,
  }),

  client_welcome_confirmed: () => ({
    subject: `Bienvenue chez Ikadou, {{first_name}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Bienvenue sur Ikadou</h1>
  <p class="subtitle">Votre compte client est confirmé.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre espace client Ikadou est maintenant actif. Vous pouvez suivre vos projets, vos visites, vos paiements et échanger avec notre support.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Compte</span><br><span class="value">Confirmé et sécurisé</span></div>
    <div class="row"><span class="label">Parcours</span><br><span class="value">Simulation · Visite · Paiement · Suivi</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn">Accéder à mon espace</a></p>
</div>`,
  }),

  visit_created: () => ({
    subject: `Demande de visite reçue — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-info">📅</div>
  <h1 class="title">Demande de visite reçue</h1>
  <p class="subtitle">Notre équipe va vérifier le créneau demandé.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre demande de visite pour <strong>{{terrain_title}}</strong> a bien été reçue.</p>

  <div class="box" style="--accent:#008C8C">
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
    <div class="row"><span class="label">Date souhaitée</span><br><span class="value">{{visit_date}}</span></div>
    <div class="row"><span class="label">Heure</span><br><span class="value">{{visit_time}}</span></div>
  </div>

  <p>Vous recevrez une confirmation dès que le créneau sera validé.</p>
</div>`,
  }),

  visit_confirmation: () => ({
    subject: `Visite confirmée — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Votre visite est confirmée</h1>
  <p class="subtitle">Le rendez-vous est bien enregistré.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre visite du terrain <strong>{{terrain_title}}</strong> est confirmée.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Date</span><br><span class="value">{{visit_date}}</span></div>
    <div class="row"><span class="label">Heure</span><br><span class="value">{{visit_time}}</span></div>
    <div class="row"><span class="label">Agent</span><br><span class="value">{{agent_name}}</span></div>
    <div class="row"><span class="label">Contact</span><br><span class="value">{{agent_phone}}</span></div>
  </div>

  <p class="info">Pensez à vous munir d’une pièce d’identité pour la visite.</p>
</div>`,
  }),

  visit_reminder: () => ({
    subject: `Rappel : votre visite demain — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-warning">🔔</div>
  <h1 class="title">Rappel de visite</h1>
  <p class="subtitle">Votre visite est prévue demain.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Nous vous rappelons votre visite pour le terrain <strong>{{terrain_title}}</strong>.</p>

  <div class="box" style="--accent:#F4B740">
    <div class="row"><span class="label">Heure</span><br><span class="value">{{visit_time}}</span></div>
    <div class="row"><span class="label">Agent</span><br><span class="value">{{agent_name}}</span></div>
    <div class="row"><span class="label">Contact</span><br><span class="value">{{agent_phone}}</span></div>
  </div>
</div>`,
  }),

  visit_rescheduled: () => ({
    subject: `Visite replanifiée — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-orange">↻</div>
  <h1 class="title">Votre visite a été replanifiée</h1>
  <p class="subtitle">Un nouveau créneau a été enregistré.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre visite du terrain <strong>{{terrain_title}}</strong> a été déplacée.</p>

  <div class="box" style="--accent:#F28C28">
    <div class="row"><span class="label">Nouvelle date</span><br><span class="value">{{new_date}}</span></div>
    <div class="row"><span class="label">Nouvelle heure</span><br><span class="value">{{new_time}}</span></div>
    <div class="row"><span class="label">Agent</span><br><span class="value">{{agent_name}}</span></div>
    <div class="row"><span class="label">Contact</span><br><span class="value">{{agent_phone}}</span></div>
  </div>
</div>`,
  }),

  visit_cancelled: () => ({
    subject: `Visite annulée — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-danger">×</div>
  <h1 class="title">Visite annulée</h1>
  <p class="subtitle">Le rendez-vous prévu a été annulé.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre visite du terrain <strong>{{terrain_title}}</strong> prévue le <strong>{{visit_date}}</strong> à <strong>{{visit_time}}</strong> a été annulée.</p>

  <div class="box" style="--accent:#D64545">
    <div class="row"><span class="label">Motif</span><br><span class="value">{{cancel_reason}}</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn btn-orange">Planifier une nouvelle visite</a></p>
</div>`,
  }),

  visit_completed: () => ({
    subject: `Visite effectuée — {{terrain_title}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Visite effectuée</h1>
  <p class="subtitle">Vous pouvez poursuivre votre projet.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre visite du terrain <strong>{{terrain_title}}</strong> est marquée comme effectuée.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
    <div class="row"><span class="label">Prochaine étape</span><br><span class="value">Poursuivre le projet ou initier un paiement</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn">Voir mon projet</a></p>
</div>`,
  }),

  payment_created: () => ({
    subject: `Paiement initié — Réf. {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-orange">💳</div>
  <h1 class="title">Paiement initié</h1>
  <p class="subtitle">Votre demande de paiement a été créée.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre paiement a été créé avec succès. Suivez les instructions dans votre espace client pour finaliser l’opération.</p>

  <div class="box" style="--accent:#F28C28">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Montant</span><br><span class="value">{{amount}} {{currency}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>
</div>`,
  }),

  payment_pending: () => ({
    subject: `Paiement en attente — {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-warning">…</div>
  <h1 class="title">Paiement en attente</h1>
  <p class="subtitle">Votre paiement est en cours de traitement.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre paiement <strong>{{payment_ref}}</strong> est en attente de validation.</p>

  <div class="box" style="--accent:#F4B740">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Montant</span><br><span class="value">{{amount}} {{currency}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>

  <p>Vous recevrez une confirmation dès validation par notre équipe.</p>
</div>`,
  }),

  payment_confirmed: () => ({
    subject: `Paiement confirmé — Réf. {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Paiement confirmé</h1>
  <p class="subtitle">Votre paiement a bien été reçu.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre paiement a été confirmé avec succès.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Montant</span><br><span class="value">{{amount}} {{currency}}</span></div>
    <div class="row"><span class="label">Date</span><br><span class="value">{{payment_date}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>

  <p class="info">Conservez cet email comme preuve de confirmation.</p>
</div>`,
  }),

  payment_failed: () => ({
    subject: `Paiement échoué — Action requise`,
    html: `
<div class="hero">
  <div class="statusIcon status-danger">!</div>
  <h1 class="title">Paiement échoué</h1>
  <p class="subtitle">Une action est requise pour poursuivre.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre paiement <strong>{{payment_ref}}</strong> de <strong>{{amount}} {{currency}}</strong> n’a pas abouti.</p>

  <div class="box" style="--accent:#D64545">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn btn-orange">Contacter le support</a></p>
</div>`,
  }),

  payment_proof_received: () => ({
    subject: `Preuve de paiement reçue — {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-info">📎</div>
  <h1 class="title">Preuve reçue</h1>
  <p class="subtitle">Votre justificatif est en cours de vérification.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre preuve de paiement pour la référence <strong>{{payment_ref}}</strong> a bien été reçue.</p>

  <div class="box" style="--accent:#008C8C">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>

  <p>Notre équipe vous notifiera dès validation.</p>
</div>`,
  }),

  payment_proof_approved: () => ({
    subject: `Preuve validée — {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Preuve validée</h1>
  <p class="subtitle">Votre justificatif de paiement a été accepté.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre preuve de paiement a été validée.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{payment_ref}}</span></div>
    <div class="row"><span class="label">Montant</span><br><span class="value">{{amount}} {{currency}}</span></div>
    <div class="row"><span class="label">Terrain</span><br><span class="value">{{terrain_title}}</span></div>
  </div>
</div>`,
  }),

  payment_proof_rejected: () => ({
    subject: `Preuve de paiement rejetée — {{payment_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-danger">!</div>
  <h1 class="title">Preuve rejetée</h1>
  <p class="subtitle">Une nouvelle preuve est nécessaire.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre preuve de paiement pour <strong>{{payment_ref}}</strong> n’a pas pu être validée.</p>

  <div class="box" style="--accent:#D64545">
    <div class="row"><span class="label">Motif</span><br><span class="value">{{reason}}</span></div>
  </div>

  <p>Merci de soumettre une nouvelle preuve depuis votre espace.</p>
</div>`,
  }),

  ticket_opened: () => ({
    subject: `Ticket support créé — Réf. {{ticket_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-info">💬</div>
  <h1 class="title">Demande support créée</h1>
  <p class="subtitle">Votre demande a été enregistrée.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre demande de support a bien été prise en compte.</p>

  <div class="box" style="--accent:#008C8C">
    <div class="row"><span class="label">Référence</span><br><span class="value">{{ticket_ref}}</span></div>
    <div class="row"><span class="label">Sujet</span><br><span class="value">{{subject}}</span></div>
    <div class="row"><span class="label">Priorité</span><br><span class="value">{{priority}}</span></div>
  </div>

  <p>Notre équipe traitera votre demande dans les meilleurs délais.</p>
</div>`,
  }),

  support_reply: () => ({
    subject: `Nouvelle réponse support — {{ticket_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-info">✉</div>
  <h1 class="title">Nouvelle réponse du support</h1>
  <p class="subtitle">Notre équipe a répondu à votre demande.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Une nouvelle réponse est disponible sur votre ticket <strong>{{ticket_ref}}</strong>.</p>

  <div class="box" style="--accent:#008C8C">
    <div class="row"><span class="label">Sujet</span><br><span class="value">{{subject}}</span></div>
    <div class="row"><span class="label">Message</span><br><span class="value">{{reply_preview}}</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn">Ouvrir la discussion</a></p>
</div>`,
  }),

  support_status_changed: () => ({
    subject: `Statut du ticket mis à jour — {{ticket_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-orange">↻</div>
  <h1 class="title">Statut support mis à jour</h1>
  <p class="subtitle">Votre demande a changé d’état.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Le statut de votre demande support a été mis à jour.</p>

  <div class="box" style="--accent:#F28C28">
    <div class="row"><span class="label">Ticket</span><br><span class="value">{{ticket_ref}}</span></div>
    <div class="row"><span class="label">Sujet</span><br><span class="value">{{subject}}</span></div>
    <div class="row"><span class="label">Nouveau statut</span><br><span class="value">{{status_label}}</span></div>
  </div>
</div>`,
  }),

  ticket_resolved: () => ({
    subject: `Votre demande a été résolue — {{ticket_ref}}`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Demande résolue</h1>
  <p class="subtitle">Votre ticket support est clôturé côté traitement.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre demande <strong>{{ticket_ref}}</strong> concernant <strong>{{subject}}</strong> a été résolue.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Ticket</span><br><span class="value">{{ticket_ref}}</span></div>
    <div class="row"><span class="label">Statut</span><br><span class="value">Résolu</span></div>
  </div>

  <p>Si le problème persiste, vous pouvez rouvrir une discussion avec notre support.</p>
</div>`,
  }),

  lead_assigned: () => ({
    subject: `Un agent vous a été assigné — Ikadou`,
    html: `
<div class="hero">
  <div class="statusIcon status-info">👤</div>
  <h1 class="title">Votre dossier est pris en charge</h1>
  <p class="subtitle">Un agent dédié vous accompagne.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Un agent Ikadou a été assigné à votre dossier.</p>

  <div class="box" style="--accent:#008C8C">
    <div class="row"><span class="label">Agent</span><br><span class="value">{{agent_name}}</span></div>
    <div class="row"><span class="label">Téléphone</span><br><span class="value">{{agent_phone}}</span></div>
  </div>
</div>`,
  }),

  account_suspended: () => ({
    subject: `Votre compte Ikadou a été suspendu`,
    html: `
<div class="hero">
  <div class="statusIcon status-danger">!</div>
  <h1 class="title">Compte suspendu</h1>
  <p class="subtitle">Votre accès est temporairement limité.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Votre compte Ikadou a été temporairement suspendu.</p>

  <div class="box" style="--accent:#D64545">
    <div class="row"><span class="label">Statut</span><br><span class="value">Suspendu</span></div>
  </div>

  <p>Veuillez contacter notre support pour plus d’informations.</p>
</div>`,
  }),

  account_reactivated: () => ({
    subject: `Votre compte Ikadou est réactivé`,
    html: `
<div class="hero">
  <div class="statusIcon status-success">✓</div>
  <h1 class="title">Compte réactivé</h1>
  <p class="subtitle">Votre espace est de nouveau accessible.</p>
</div>
<div class="body">
  <p>Bonjour <strong>{{first_name}}</strong>,</p>
  <p>Bonne nouvelle, votre compte Ikadou est de nouveau actif.</p>

  <div class="box" style="--accent:#14A44D">
    <div class="row"><span class="label">Statut</span><br><span class="value">Compte actif</span></div>
  </div>

  <p><a href="{{app_url}}" class="btn">Accéder à mon espace</a></p>
</div>`,
  }),

  password_reset: () => ({
    subject: `Réinitialisation de votre mot de passe`,
    html: `
<div class="hero">
  <div class="statusIcon status-warning">🔐</div>
  <h1 class="title">Réinitialisation du mot de passe</h1>
  <p class="subtitle">Utilisez le lien sécurisé pour définir un nouveau mot de passe.</p>
</div>
<div class="body">
  <p>Bonjour,</p>
  <p>Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable temporairement.</p>

  <p><a href="{{reset_url}}" class="btn btn-orange">Réinitialiser mon mot de passe</a></p>

  <p class="info">Si vous n’êtes pas à l’origine de cette demande, ignorez cet email.</p>
</div>`,
  }),

  custom: (v) => ({
    subject: v.subject || 'Message Ikadou',
    html: `
<div class="hero">
  <div class="statusIcon status-info">✉</div>
  <h1 class="title">{{subject}}</h1>
</div>
<div class="body">
  ${v.body || ''}
</div>`,
  }),
};

// ─── Interpolation helper ─────────────────────────────────

const interpolate = (str, vars = {}) => {
  if (!str) return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{{${key}}}`);
};


const BRAND_EMAIL = {
  teal: '#008C8C',
  orange: '#F28C28',
  green: '#14A44D',
  yellow: '#F4B740',
  red: '#D64545',
  black: '#111111',
  text: '#2D2A26',
  soft: '#6F6B64',
  bg: '#F7F4EF',
  white: '#FFFFFF',
  border: '#E9E2D8',
};

const logoUrl =
  process.env.EMAIL_LOGO_URL ||
  process.env.IKADOU_LOGO_URL ||
  '';

const BASE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
body{margin:0;padding:0;background:${BRAND_EMAIL.bg};font-family:Arial,'Helvetica Neue',sans-serif;color:${BRAND_EMAIL.text}}
.wrapper{width:100%;background:${BRAND_EMAIL.bg};padding:28px 12px}
.card{max-width:620px;margin:0 auto;background:${BRAND_EMAIL.white};border-radius:22px;overflow:hidden;border:1px solid ${BRAND_EMAIL.border};box-shadow:0 12px 36px rgba(17,17,17,.08)}
.header{background:${BRAND_EMAIL.black};padding:26px 30px;text-align:center}
.logoImg{max-width:138px;height:auto;margin:0 auto 10px;display:block}
.logoText{color:${BRAND_EMAIL.teal};font-size:26px;font-weight:800;letter-spacing:-.5px}
.logoLine{width:42px;height:4px;background:${BRAND_EMAIL.orange};border-radius:99px;margin:0 auto 8px}
.tagline{color:rgba(255,255,255,.62);font-size:12px}
.hero{padding:30px 30px 10px;text-align:center}
.statusIcon{width:58px;height:58px;border-radius:29px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:26px}
.status-success{background:rgba(20,164,77,.10);color:${BRAND_EMAIL.green}}
.status-info{background:rgba(0,140,140,.10);color:${BRAND_EMAIL.teal}}
.status-warning{background:rgba(244,183,64,.16);color:${BRAND_EMAIL.yellow}}
.status-orange{background:rgba(242,140,40,.12);color:${BRAND_EMAIL.orange}}
.status-danger{background:rgba(214,69,69,.10);color:${BRAND_EMAIL.red}}
.title{font-size:24px;line-height:31px;font-weight:800;color:${BRAND_EMAIL.black};margin:0 0 8px}
.subtitle{font-size:14px;line-height:22px;color:${BRAND_EMAIL.soft};margin:0}
.body{padding:18px 30px 34px;font-size:15px;line-height:1.75}
.box{background:#FCFAF7;border:1px solid ${BRAND_EMAIL.border};border-left:5px solid var(--accent, ${BRAND_EMAIL.teal});border-radius:16px;padding:16px 18px;margin:20px 0;color:${BRAND_EMAIL.text}}
.row{margin:6px 0}
.label{color:${BRAND_EMAIL.soft};font-size:12px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.value{font-size:15px;font-weight:700;color:${BRAND_EMAIL.black}}
.btn{display:inline-block;margin:18px 0 4px;padding:13px 24px;background:${BRAND_EMAIL.teal};color:#fff!important;border-radius:12px;text-decoration:none;font-weight:800;font-size:14px}
.btn-orange{background:${BRAND_EMAIL.orange}}
.info{font-size:12px;line-height:18px;color:${BRAND_EMAIL.soft};border-top:1px solid ${BRAND_EMAIL.border};padding-top:16px;margin-top:24px}
.footer{background:#FCFAF7;padding:20px 30px;text-align:center;font-size:12px;line-height:18px;color:${BRAND_EMAIL.soft};border-top:1px solid ${BRAND_EMAIL.border}}
.footer a{color:${BRAND_EMAIL.teal};text-decoration:none;font-weight:700}
@media(max-width:520px){.wrapper{padding:12px 8px}.header,.hero,.body,.footer{padding-left:20px;padding-right:20px}.title{font-size:21px;line-height:28px}}
</style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        {{#if logoUrl}}
          <img src="{{logoUrl}}" class="logoImg" alt="Ikadou"/>
        {{else}}
          <div class="logoLine"></div>
          <div class="logoText">ikadou</div>
        {{/if}}
        <div class="tagline">Investir au Mali, en toute sérénité</div>
      </div>
      {{{body}}}
      <div class="footer">
        <p>© {{year}} Ikadou · Bamako, Mali</p>
        <p>Email automatique — merci de ne pas répondre directement.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
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
    logoUrl,
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