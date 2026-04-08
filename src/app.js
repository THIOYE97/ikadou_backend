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

app.use(`${API}/auth`, authRoutes);
app.use(`${API}/users`, userRoutes);
app.use(`${API}/leads`, require('./routes/leadRoutes'));
app.use(`${API}/clients`, require('./routes/clientRoutes'));
app.use(`${API}/terrains`, require('./routes/terrainRoutes'));
app.use(`${API}/terrains`, require('./routes/terrainImageRoutes'));
app.use(`${API}/zones`, require('./routes/zoneRoutes'));
app.use(`${API}/visits`, require('./routes/visitRoutes'));
app.use(`${API}/payments`, require('./routes/paymentRoutes'));
app.use(`${API}/documents`, require('./routes/documentRoutes'));
app.use(`${API}/tickets`, require('./routes/ticketRoutes'));
app.use(`${API}/agents`, require('./routes/agentRoutes'));
app.use(`${API}/notifications`, require('./routes/notificationRoutes'));
app.use(`${API}/dashboard`, require('./routes/dashboardRoutes'));
app.use(`${API}/reports`, require('./routes/reportRoutes'));
app.use(`${API}/client/notifications`, require('./routes/clientNotificationsRoutes'));
app.use(`${API}/public`, require('./routes/publicRoutes'));
app.use(`${API}/client-auth`, require('./routes/clientAuthRoutes'));
app.use(`${API}/client/profile`, require('./routes/clientProfileRoutes'));
app.use(`${API}/client/visits`, require('./routes/clientVisitRoutes'));

app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Route not found' })
);

app.use(errorHandler);

module.exports = app;
