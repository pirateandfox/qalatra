// CJS shim — allows utilityProcess.fork() to launch ESM mcp/http-server.js
import('./http-server.js').catch(err => {
  console.error('[mcp-entry] failed to start http-server.js:', err);
  process.exit(1);
});
