// The Express app, shared by the local server (server.js) and the Vercel function (api/index.js)
const express = require('express');
require('dotenv').config();

const corsMiddleware = require('./config/cors');
const connectDB = require('./config/db');

const app = express();

// Vercel and most hosts sit behind a proxy: trust it so req.ip / req.protocol are correct
app.set('trust proxy', 1);

app.use(corsMiddleware);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// Health check (no database needed)
app.get('/', (req, res) => {
  res.status(200).json({ message: 'ShipDay API is running', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Make sure the database is connected before any API route runs
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('❌ DB Connection Error:', err.message);
    res.status(503).json({ message: 'Service temporarily unavailable. Please try again.' });
  }
});

app.use('/api', require('./routes'));

// Errors not handled by a route: blocked origins, upload problems, anything unexpected
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'This website is not allowed to use the ShipDay API' });
  }
  if (err.name === 'MulterError' || /files are allowed/.test(err.message || '')) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : err.message;
    return res.status(400).json({ message });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

module.exports = app;
