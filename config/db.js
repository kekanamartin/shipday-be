const mongoose = require('mongoose');

// Reuse one connection across requests. On Vercel each function instance keeps its module state
// between invocations, so caching on `global` stops every request from opening a new connection.
const cache = global.__shipdayMongo || (global.__shipdayMongo = { conn: null, promise: null });

const connectDB = async () => {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI environment variable is not set');
  }
  if (!cache.promise) {
    cache.promise = mongoose
      .connect(process.env.MONGO_URI, {
        // Fail fast instead of hanging a serverless request when the database is unreachable
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 10,
      })
      .then((m) => {
        console.log('✅ MongoDB connected');
        return m;
      })
      .catch((err) => {
        cache.promise = null; // let the next request retry
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
};

module.exports = connectDB;
