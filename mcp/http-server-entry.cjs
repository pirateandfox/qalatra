// A parent-managed MCP child must never outlive the Qalatra Server generation that owns it.
// The IPC pipe closes even when the parent is SIGKILLed, where no parent cleanup handler can run.
// Register this before importing the ESM server so the child is tethered during initialization too.
if (process.connected) {
  process.once('disconnect', () => process.exit(0));
}

// CJS shim — allows utilityProcess.fork() and child_process.spawn() to launch ESM http-server.js
import('./http-server.js').catch(err => {
  console.error('[mcp-entry] failed to start http-server.js:', err);
  process.exit(1);
});
