const cors = require('cors');

// Origins that are always allowed (existing deployments and local development)
const STATIC_ORIGINS = [
  'https://lemon-moss-0af8f730f.1.azurestaticapps.net',
  'https://shipday-be.vercel.app',
  'http://192.168.0.54:8081',
  'http://192.168.0.54:5000',
];

const trimSlash = (url) => String(url || '').trim().replace(/\/+$/, '');

// Builds the allow-list from the environment on each check, so a redeploy isn't needed in tests.
//   FRONTEND_URL / BASE_URL  the live frontend (www and non-www are both allowed)
//   CORS_ORIGINS             extra origins, comma-separated; "*" matches one host label,
//                            e.g. https://shipday-fe-*.vercel.app for Vercel preview deployments
const allowedOriginMatchers = () => {
  const exact = new Set(STATIC_ORIGINS);
  const patterns = [];

  [process.env.FRONTEND_URL, process.env.BASE_URL].filter(Boolean).forEach((value) => {
    const url = trimSlash(value);
    exact.add(url);
    exact.add(url.includes('://www.') ? url.replace('://www.', '://') : url.replace('://', '://www.'));
  });

  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(trimSlash)
    .filter(Boolean)
    .forEach((origin) => {
      if (origin.includes('*')) {
        const escaped = origin.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
        patterns.push(new RegExp(`^${escaped}$`, 'i'));
      } else {
        exact.add(origin);
      }
    });

  return { exact, patterns };
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // mobile apps, curl, server-to-server
  const value = trimSlash(origin);
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) return true;
  const { exact, patterns } = allowedOriginMatchers();
  return exact.has(value) || patterns.some((re) => re.test(value));
};

const originCheck = (origin, callback) => {
  if (isAllowedOrigin(origin)) return callback(null, true);
  console.error(`CORS Blocked Origin: ${origin}`);
  return callback(new Error('Not allowed by CORS'));
};

const corsOptions = {
  origin: originCheck,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-API-Key', 'Idempotency-Key'],
  credentials: true,
  optionsSuccessStatus: 200,
};

module.exports = cors(corsOptions);
module.exports.isAllowedOrigin = isAllowedOrigin;
module.exports.originCheck = originCheck;
