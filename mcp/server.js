import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { toolDefs as taskDefs,     handlers as taskHandlers }     from './tools/tasks.js';
import { toolDefs as triageDefs,   handlers as triageHandlers }   from './tools/triage.js';
import { toolDefs as briefingDefs, handlers as briefingHandlers } from './tools/briefing.js';
import { toolDefs as syncDefs,     handlers as syncHandlers }     from './tools/sync.js';
import { toolDefs as notesDefs,    handlers as notesHandlers }    from './tools/notes.js';
import { toolDefs as agentDefs,    handlers as agentHandlers }    from './tools/agent.js';
import { toolDefs as habitDefs,    handlers as habitHandlers }    from './tools/habits.js';

const allDefs     = [...taskDefs, ...triageDefs, ...briefingDefs, ...syncDefs, ...notesDefs, ...agentDefs, ...habitDefs];
const allHandlers = { ...taskHandlers, ...triageHandlers, ...briefingHandlers, ...syncHandlers, ...notesHandlers, ...agentHandlers, ...habitHandlers };

const server = new Server(
  { name: 'task-os', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = allHandlers[name];

  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = handler(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
