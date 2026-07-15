/**
 * PM2 entrypoint (CommonJS). Delegates to ecosystem.config.js so either
 * `pm2 start ecosystem.config.cjs` or `pm2 start ecosystem.config.js` works.
 */
module.exports = require("./ecosystem.config.js");
