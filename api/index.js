// Vercel serverless entry point: every request is routed here by vercel.json.
// The database connects on the first /api request and the connection is reused (config/db.js).
module.exports = require('../app');
