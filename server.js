// Stable deployment entry point. Application code lives in src/server/.
if (require.main === module) {
  require('./src/server/start').startServer();
} else {
  module.exports = require('./src/server/app');
}
