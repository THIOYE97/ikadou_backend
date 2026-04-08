require('dotenv').config();

const parseBool = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'ikadou_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_MAX_POOL, 10) || 20,
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) || 2000,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'ikadou_dev_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'ikadou_refresh_secret',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  },

  upload: {
    maxSizeMb: parseInt(process.env.UPLOAD_MAX_SIZE_MB, 10) || 10,
    dir: process.env.UPLOAD_DIR || './uploads',
  },

  email: {
    host: process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT, 10) || 587,
    secure: parseBool(process.env.EMAIL_SECURE ?? process.env.SMTP_SECURE, false),
    user: process.env.EMAIL_USER || process.env.SMTP_USER || null,
    pass: process.env.EMAIL_PASS || process.env.SMTP_PASS || null,
    fromName: process.env.EMAIL_FROM_NAME || process.env.SMTP_FROM_NAME || 'Ikadou',
    fromEmail:
      process.env.EMAIL_FROM_EMAIL ||
      process.env.SMTP_FROM_EMAIL ||
      process.env.EMAIL_USER ||
      process.env.SMTP_USER ||
      null,
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || null,
    authToken: process.env.TWILIO_AUTH_TOKEN || null,
    smsFrom: process.env.TWILIO_SMS_FROM || null,
    waFrom:
      process.env.TWILIO_WA_FROM ||
      process.env.TWILIO_WHATSAPP_FROM ||
      'whatsapp:+14155238886',
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || null,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : null,
  },

  notifications: {
    emailEnabled: parseBool(
      process.env.NOTIFICATIONS_EMAIL_ENABLED ?? process.env.NOTIF_EMAIL_ENABLED,
      true
    ),
    smsEnabled: parseBool(
      process.env.NOTIFICATIONS_SMS_ENABLED ?? process.env.NOTIF_SMS_ENABLED,
      true
    ),
    pushEnabled: parseBool(
      process.env.NOTIFICATIONS_PUSH_ENABLED ?? process.env.NOTIF_PUSH_ENABLED,
      true
    ),
    whatsappEnabled: parseBool(
      process.env.NOTIFICATIONS_WHATSAPP_ENABLED ?? process.env.NOTIF_WHATSAPP_ENABLED,
      false
    ),
  },

  app: {
    url: process.env.APP_URL || 'http://localhost:5173',
    apiUrl: process.env.API_URL || `http://localhost:${parseInt(process.env.PORT, 10) || 5000}`,
    supportPhone: process.env.SUPPORT_PHONE || '+22300000000',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
config.stripe = {
  secretKey:      process.env.STRIPE_SECRET_KEY,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  webhookSecret:  process.env.STRIPE_WEBHOOK_SECRET,
  currency:       process.env.STRIPE_CURRENCY || 'eur',
};

config.danapay = {
  apiKey:        process.env.DANAPAY_API_KEY,
  apiSecret:     process.env.DANAPAY_API_SECRET,
  baseUrl:       process.env.DANAPAY_BASE_URL || 'https://api.danapay.io/v1',
  webhookSecret: process.env.DANAPAY_WEBHOOK_SECRET,
  currency:      process.env.DANAPAY_CURRENCY || 'XOF',
};

config.payment = {
  callbackBaseUrl: process.env.PAYMENT_CALLBACK_BASE_URL || 'http://localhost:5000',
  successUrl:      process.env.PAYMENT_SUCCESS_URL || 'http://localhost:3000/payment/success',
  cancelUrl:       process.env.PAYMENT_CANCEL_URL  || 'http://localhost:3000/payment/cancel',
};

config.cloudinary= {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET,
}

module.exports = config;