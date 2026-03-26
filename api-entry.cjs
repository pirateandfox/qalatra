// CJS shim — allows utilityProcess.fork() to launch ESM api.js
// package.json has "type":"module", so .cjs is needed to opt into CommonJS
import('./api.js').catch(err => {
  console.error('[api-entry] failed to start api.js:', err);
  process.exit(1);
});
