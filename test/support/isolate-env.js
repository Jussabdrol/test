// Loaded before every test file. Tests must install an in-memory pool explicitly.
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DB_|OPENAI_|SESSION_SECRET$)/.test(key)) {
    delete process.env[key];
  }
}
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-test-session-secret';
require('pg').Pool = class DisabledNetworkPool {
  constructor() {
    throw new Error('Real PostgreSQL connections are disabled in tests; install TestPool first.');
  }
};

// HTTP integration tests may communicate only with their local test server.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect forwards an already-normalized argument array, while direct
  // socket.connect calls use the public options/port overloads.
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === 'object' ? values[0]
    : typeof values[0] === 'string' && !/^\d+$/.test(values[0]) ? { path: values[0] }
      : { host: typeof values[1] === 'string' ? values[1] : 'localhost' };
  if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost')) {
    throw new Error('External network connections are disabled in tests.');
  }
  return connect.apply(this, args);
};
