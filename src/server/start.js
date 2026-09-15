const { app } = require('./app');
const db = require('./database');
const PORT = process.env.PORT || 3000;

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start server with database initialization
let server;
async function startServer() {
  try {
    // Initialize Supabase PostgreSQL database
    await db.initDatabase();
    console.log('Database: Supabase PostgreSQL');

    server = app.listen(PORT, () => {
      console.log(`BOP running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown – Railway sends SIGTERM on deploys/restarts
function gracefulShutdown(signal) {
  console.log(`${signal} received – shutting down gracefully…`);
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      await db.close();
      console.log('Database pool closed');
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { startServer };
