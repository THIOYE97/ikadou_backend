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

// ─── Route imports ────────────────────────────────────────
const authRoutes    = require('./routes/authRoutes');
const userRoutes    = require('./routes/userRoutes');

//const clientNotificationsRoutes = require('./routes/clientNotificationsRoutes');
// ─── Placeholder routes (to be implemented in next phases)
// const leadRoutes    = require('./routes/leadRoutes');
// const clientRoutes  = require('./routes/clientRoutes');
// const terrainRoutes = require('./routes/terrainRoutes');
// const visitRoutes   = require('./routes/visitRoutes');
// const paymentRoutes = require('./routes/paymentRoutes');
// const documentRoutes = require('./routes/documentRoutes');
// const ticketRoutes  = require('./routes/ticketRoutes');
// const agentRoutes   = require('./routes/agentRoutes');
// const zoneRoutes    = require('./routes/zoneRoutes');
// const notifRoutes   = require('./routes/notificationRoutes');
// const dashboardRoutes = require('./routes/dashboardRoutes');
// const reportRoutes  = require('./routes/reportRoutes');

const app = express();

// ─── Security & global middleware ────────────────────────
app.use(helmet());
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

// ─── Static files — uploaded images ──────────────────────
app.use('/uploads', express.static(path.resolve(config.upload.dir || './uploads')));

// ─── Health check ─────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({
    success: true,
    status: 'ok',
    env: config.env,
    timestamp: new Date().toISOString(),
  })
);

// ─── API Routes ───────────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`,    authRoutes);
app.use(`${API}/users`,   userRoutes);

// Phase 2 routes
app.use(`${API}/leads`,       require('./routes/leadRoutes'));
app.use(`${API}/clients`,     require('./routes/clientRoutes'));
app.use(`${API}/terrains`,    require('./routes/terrainRoutes'));
app.use(`${API}/terrains`,    require('./routes/terrainImageRoutes'));
app.use(`${API}/zones`,       require('./routes/zoneRoutes'));

// Phase 3+ routes
app.use(`${API}/visits`,        require('./routes/visitRoutes'));
app.use(`${API}/payments`,      require('./routes/paymentRoutes'));
app.use(`${API}/documents`,     require('./routes/documentRoutes'));
app.use(`${API}/tickets`,       require('./routes/ticketRoutes'));
app.use(`${API}/agents`,        require('./routes/agentRoutes'));
app.use(`${API}/notifications`, require('./routes/notificationRoutes'));
app.use(`${API}/dashboard`,     require('./routes/dashboardRoutes'));
app.use(`${API}/reports`,       require('./routes/reportRoutes'));
app.use(`${API}/client/notifications`,  require('./routes/clientNotificationsRoutes'));
// ─── 404 handler ──────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Route not found' })
);

// ─── Global error handler ─────────────────────────────────
app.use(errorHandler);

module.exports = app;
