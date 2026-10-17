// Local / long-running server (node server.js). On Vercel, api/index.js is used instead.
const http = require('http');
require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const { initializeSocket } = require('./config/socket');

const PORT = process.env.PORT || process.env.WEBSITES_PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI environment variable is not set');
  process.exit(1);
}

// Live notifications need a long-running server, so Socket.IO only runs here (not on Vercel)
const server = http.createServer(app);
app.set('io', initializeSocket(server));

connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ DB Connection Error:', err.message);
    process.exit(1);
  });
