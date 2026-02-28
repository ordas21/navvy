import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerSystemTools } from './system-tools.js';

const server = new McpServer({
  name: 'browser',
  version: '1.0.0',
});

registerTools(server);
registerSystemTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
