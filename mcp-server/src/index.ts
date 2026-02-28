import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerSystemTools } from './system-tools.js';
import { startProxyServer } from './cdp-proxy.js';

const cdpMode = process.env.NAVVY_CDP_MODE || 'extension';
if (cdpMode === 'extension') {
  await startProxyServer();
}

const server = new McpServer({
  name: 'browser',
  version: '1.0.0',
});

registerTools(server);
registerSystemTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
