import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initAuth, authenticate, requireScope } from '../server/auth.js';

import { toolDefs as taskDefs,     handlers as taskHandlers }     from './tools/tasks.js';
import { toolDefs as triageDefs,   handlers as triageHandlers }   from './tools/triage.js';
import { toolDefs as briefingDefs, handlers as briefingHandlers } from './tools/briefing.js';
import { toolDefs as syncDefs,     handlers as syncHandlers }     from './tools/sync.js';
import { toolDefs as notesDefs,    handlers as notesHandlers }    from './tools/notes.js';
import { toolDefs as agentDefs,    handlers as agentHandlers }    from './tools/agent.js';
import { toolDefs as habitDefs,       handlers as habitHandlers }       from './tools/habits.js';
import { toolDefs as healthDefs,      handlers as healthHandlers }      from './tools/health.js';
import { toolDefs as heartbeatDefs,   handlers as heartbeatHandlers }   from './tools/heartbeats.js';
import { toolDefs as capabilityDefs,  handlers as capabilityHandlers }  from './tools/capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.TASKOS_SETTINGS_FILE
  ?? path.join(__dirname, '../db/settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

// Auth — reuses the same auth_tokens table as the API server.
// QALATRA_MCP_AUTH modes:
//   local-bypass (default) — loopback callers skip auth; non-loopback require a valid token.
//   required               — every request needs a valid token, including loopback.
//                            Use this on any box where the MCP port is reachable via a tunnel.
//   off                    — no auth (today's behaviour, explicit opt-out).
//
// ⚠️  WARNING: behind a cloudflared tunnel the request arrives from 127.0.0.1 (the local
// cloudflared daemon). local-bypass is therefore UNSAFE on a tunneled box.
// Any box with an MCP ingress hostname MUST set QALATRA_MCP_AUTH=required.
const MCP_AUTH_MODE = (process.env.QALATRA_MCP_AUTH || 'local-bypass').toLowerCase()
const DATA_DIR_FOR_AUTH = process.env.TASKOS_DB_DIR ?? path.join(__dirname, '../db')
const authDb = initAuth(path.join(DATA_DIR_FOR_AUTH, 'tasks.db'))

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// Returns true if the request is authorized. Writes 401 and returns false if not.
// Also stamps req._mcpFullAccess so tool-call scope can be enforced downstream (bug C7):
// the MCP port must honor the same scope model as the HTTP API (server/index.js requires
// full_access for every /api/ route). A read_only token authenticates but must not invoke
// mutating tools. local-bypass/off grant full access, preserving prior local-caller behaviour.
function checkMcpAuth(req, res) {
  if (MCP_AUTH_MODE === 'off') { req._mcpFullAccess = true; return true }
  if (MCP_AUTH_MODE === 'local-bypass' && isLoopback(req.socket?.remoteAddress)) { req._mcpFullAccess = true; return true }
  const user = authenticate(authDb, req)
  if (!user) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="Qalatra MCP"',
    })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return false
  }
  req._mcpFullAccess = requireScope(user, 'full_access')
  return true
}

const allDefs     = [...taskDefs, ...triageDefs, ...briefingDefs, ...syncDefs, ...notesDefs, ...agentDefs, ...habitDefs, ...healthDefs, ...heartbeatDefs, ...capabilityDefs];
const allHandlers = { ...taskHandlers, ...triageHandlers, ...briefingHandlers, ...syncHandlers, ...notesHandlers, ...agentHandlers, ...habitHandlers, ...healthHandlers, ...heartbeatHandlers, ...capabilityHandlers };

function createMcpServer({ fullAccess = false } = {}) {
  const server = new Server(
    { name: 'qalatra', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Listing tool definitions is harmless metadata — allowed for any authenticated caller.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allDefs }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Scope gate (bug C7): invoking any tool requires full_access, mirroring the HTTP API
    // (server/index.js requires full_access for every /api/ route). Without this a read_only
    // token — the default token class — could call every mutating tool via the MCP port.
    if (!fullAccess) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Forbidden: this token lacks the full_access scope required to call MCP tools' }) }], isError: true };
    }
    const handler = allHandlers[name];
    if (!handler) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
    // Retry on SQLITE_BUSY — multiple concurrent agents can cause write-lock contention.
    // Each retry waits longer; total max wait ~3.5s, well inside the 5s Axios timeout.
    const delays = [200, 500, 1000, 1800];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const result = await handler(args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err.code === 'SQLITE_BUSY' && attempt < delays.length) {
          lastErr = err;
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ error: `DB busy after retries: ${lastErr.message}` }) }], isError: true };
  });

  return server;
}

const settings = loadSettings();
const PORT = parseInt(process.env.QALATRA_MCP_PORT || settings.mcpPort || '3457', 10);
const HOST = process.env.QALATRA_MCP_HOST || settings.mcpHost || '127.0.0.1';

const transports = {};

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on('error', reject);
  });
}

const REQUEST_TIMEOUT_MS = 20_000; // 20 s — kill hung requests

const SERVER_STARTED_AT = new Date().toISOString();

const httpServer = http.createServer(async (req, res) => {
  // Abort any request that hasn't completed within the timeout window.
  const timeout = setTimeout(() => {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Request timeout' }, id: null }));
    }
    // Destroy the underlying socket so the client gets a hard close rather than
    // waiting on an SSE channel that will never deliver a result.
    req.socket?.destroy();
  }, REQUEST_TIMEOUT_MS);
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id, Authorization');

  res.on('finish', () => clearTimeout(timeout));
  res.on('close',  () => clearTimeout(timeout));

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — no session required, responds immediately. Agents can hit
  // GET /health before a tool call to verify the server is reachable and detect
  // restarts (started_at changes across server processes).
  if (url.pathname === '/health') {
    clearTimeout(timeout);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, started_at: SERVER_STARTED_AT }));
    return;
  }

  if (url.pathname !== '/mcp') {
    // Auth is only enforced on /mcp. /health and 404s are exempt.
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!checkMcpAuth(req, res)) return;

  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'POST') {
    const body = await parseBody(req);

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, body);
      return;
    }

    if (!sessionId && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sid => { transports[sid] = transport; },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };
      // Bind the caller's access level at session creation. A session belongs to one token,
      // so scopes are fixed for its lifetime; checkMcpAuth still re-validates the token
      // (revocation/expiry) on every request before we ever reach here.
      const server = createMcpServer({ fullAccess: !!req._mcpFullAccess });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // A session id we don't recognise is NOT a malformed request — it is a session this process
    // no longer has. `transports` is in-memory with no TTL, so every server restart forgets every
    // session; a client that reconnects afterwards presents a perfectly well-formed id for a
    // session that died with the previous process.
    //
    // The MCP Streamable HTTP spec distinguishes these by status: on 404 the client MUST start a
    // new session with a fresh InitializeRequest. Answering 400 instead conflates "your session is
    // gone, re-initialize" with "your request is broken", so clients surface an error to the user
    // rather than recovering. Every Qalatra release restarted the server and expired every live
    // session for exactly this reason.
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found: re-initialize' }, id: null }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing or invalid session' }, id: null }));

  } else if (req.method === 'GET') {
    if (!sessionId) {
      res.writeHead(400);
      res.end('Missing session ID');
      return;
    }
    if (!transports[sessionId]) {
      res.writeHead(404);
      res.end('Session not found: re-initialize');
      return;
    }
    await transports[sessionId].handleRequest(req, res);

  } else if (req.method === 'DELETE') {
    if (!sessionId) {
      res.writeHead(400);
      res.end('Missing session ID');
      return;
    }
    if (!transports[sessionId]) {
      // Deleting an already-gone session is the caller's desired end state, not an error. Say so
      // with 404 rather than 400 so a client tearing down after a restart doesn't log a failure.
      res.writeHead(404);
      res.end('Session not found: re-initialize');
      return;
    }
    await transports[sessionId].handleRequest(req, res);

  } else {
    res.writeHead(405);
    res.end('Method not allowed');
  }
});

httpServer.keepAliveTimeout = 65_000; // slightly above typical 60 s proxy/LB timeout
httpServer.headersTimeout   = REQUEST_TIMEOUT_MS + 1_000;
// Socket-level backstop: if a connection has no activity for 2× the request
// timeout, the OS forcibly closes the TCP socket. This catches cases where
// the MCP transport holds a connection open (SSE) but never delivers a result.
httpServer.setTimeout(REQUEST_TIMEOUT_MS * 2);

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp-http] listening on http://${HOST}:${PORT}`);
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[mcp-http] ${HOST}:${PORT} in use, retrying in 30s…`);
    setTimeout(() => httpServer.listen(PORT, HOST), 30_000);
  } else {
    console.error('[mcp-http] server error:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  for (const sid of Object.keys(transports)) {
    try { await transports[sid].close(); } catch {}
    delete transports[sid];
  }
  httpServer.close(() => process.exit(0));
});
