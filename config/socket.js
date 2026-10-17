const socketIo = require('socket.io');
const { originCheck } = require('./cors');

// Live notifications. Only used by the long-running server (server.js); Vercel has no sockets.
const initializeSocket = (server) =>
  socketIo(server, {
    cors: {
      origin: originCheck,
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

module.exports = { initializeSocket };
