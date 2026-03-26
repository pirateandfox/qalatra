import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { toolDefs as taskDefs,     handlers as taskHandlers }     from './tools/tasks.js';
import { toolDefs as triageDefs,   handlers as triageHandlers }   from './tools/triage.js';
import { toolDefs as briefingDefs, handlers as briefingHandlers } from './tools/briefing.js';
import { toolDefs as syncDefs,     handlers as syncHandlers }     from './tools/sync.js';
import { toolDefs as notesDefs,    handlers as notesHandlers }    from './tools/notes.js';
import { toolDefs as agentDefs,    handlers as agentHandlers }    from './tools/agent.js';
import { toolDefs as habitDefs,    handlers as habitHandlers }    from './tools/habits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.TASKOS_SETTINGS_FILE
  ?? path.join(__dirname, '../db/settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

const allDefs     = [...taskDefs, ...triageDefs, ...briefingDefs, ...syncDefs, ...notesDefs, ...agentDefs, ...habitDefs];
const allHandlers = { ...taskHandlers, ...triageHandlers, ...briefingHandlers, ...syncHandlers, ...notesHandlers, ...agentHandlers, ...habitHandlers };

function createMcpServer() {
  const server = new Server(
    { name: 'task-os', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allDefs }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = allHandlers[name];
    if (!handler) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
    try {
      const result = handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  return server;
}

const settings = loadSettings();
const PORT = parseInt(settings.mcpPort ?? '3457', 10);

const transports = {};

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

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
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing or invalid session' }, id: null }));

  } else if (req.method === 'GET') {
    if (!sessionId || !transports[sessionId]) {
      res.writeHead(400);
      res.end('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);

  } else if (req.method === 'DELETE') {
    if (!sessionId || !transports[sessionId]) {
      res.writeHead(400);
      res.end('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);

  } else {
    res.writeHead(405);
    res.end('Method not allowed');
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[mcp-http] listening on port ${PORT}`);
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[mcp-http] Port ${PORT} already in use`);
  } else {
    console.error('[mcp-http] error:', err);
  }
  process.exit(1);
});

process.on('SIGTERM', async () => {
  for (const sid of Object.keys(transports)) {
    try { await transports[sid].close(); } catch {}
    delete transports[sid];
  }
  httpServer.close(() => process.exit(0));
});
