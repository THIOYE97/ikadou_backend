const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const config = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const { defaultLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');

const clientSupportRoutes = require('./routes/clientSupportRoutes');
const clientPaymentRoutes = require('./routes/clientPaymentRoutes');
const clientVisitRoutes = require('./routes/clientVisitRoutes');
const clientProfileRoutes = require('./routes/clientProfileRoutes');
const clientAuthRoutes = require('./routes/clientAuthRoutes');
const clientNotificationsRoutes = require('./routes/clientNotificationsRoutes');
const clientProjectRoutes = require('./routes/ClientProjectRoutes');
const paymentMethodConfigRoutes = require('./routes/paymentMethodConfigRoutes');

const leadRoutes = require('./routes/leadRoutes');
const clientRoutes = require('./routes/clientRoutes');
const terrainRoutes = require('./routes/terrainRoutes');
const terrainImageRoutes = require('./routes/terrainImageRoutes');
const zoneRoutes = require('./routes/zoneRoutes');
const visitRoutes = require('./routes/visitRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const documentRoutes = require('./routes/documentRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const agentRoutes = require('./routes/agentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const reportRoutes = require('./routes/reportRoutes');
const publicRoutes = require('./routes/publicRoutes');

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(
  cors({
    origin: config.cors.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(compression());

app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: () => config.env === 'test',
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(defaultLimiter);

app.use('/uploads', express.static(path.resolve(config.upload.dir || './uploads')));

app.get('/health', (req, res) =>
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
);

const API = '/api/v1';

/**
 * Core / backoffice routes
 */
app.use(`${API}/auth`, authRoutes);
app.use(`${API}/users`, userRoutes);
app.use(`${API}/leads`, leadRoutes);
app.use(`${API}/clients`, clientRoutes);
app.use(`${API}/terrains`, terrainRoutes);
app.use(`${API}/terrains`, terrainImageRoutes);
app.use(`${API}/zones`, zoneRoutes);
app.use(`${API}/visits`, visitRoutes);
app.use(`${API}/payments`, paymentRoutes);
app.use(`${API}/documents`, documentRoutes);
app.use(`${API}/tickets`, ticketRoutes);
app.use(`${API}/agents`, agentRoutes);
app.use(`${API}/notifications`, notificationRoutes);
app.use(`${API}/dashboard`, dashboardRoutes);
app.use(`${API}/reports`, reportRoutes);
app.use(`${API}/payment-method-configs`, require('./routes/paymentMethodConfigRoutes'));
/**
 * Public routes
 */
app.use(`${API}/public`, publicRoutes);

/**
 * Client auth / profile routes
 */
app.use(`${API}/client-auth`, clientAuthRoutes);
app.use(`${API}/client/profile`, clientProfileRoutes);

/**
 * Client app routes
 */
app.use(`${API}/client/notifications`, clientNotificationsRoutes);
app.use(`${API}/client/visits`, clientVisitRoutes);
app.use(`${API}/client/payments`, clientPaymentRoutes);
app.use(`${API}/client/support`, clientSupportRoutes);
app.use(`${API}/client/projects`, clientProjectRoutes);

app.use((req, res) =>
  res.status(404).json({
    success: false,
    message: 'Route not found',
  })
);

app.use(errorHandler);

module.exports = app;