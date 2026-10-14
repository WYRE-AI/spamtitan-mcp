#!/usr/bin/env node
/**
 * SpamTitan MCP Server — entry point.
 *
 * Selects transport based on MCP_TRANSPORT env var:
 * - http  → stateless per-request HTTP handler (src/http.ts)
 * - stdio → single Server over stdin/stdout (this file)
 *
 * IMPORTANT: No module-level `new Server(...)`. For HTTP the server is
 * created inside createScopedMcpServer() on every request. For stdio it is
 * created once inside main() below, never at module load.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { setServerRef } from './utils/server-ref.js';
import { logger } from './utils/logger.js';

async function main() {
  const transportType = process.env.MCP_TRANSPORT || 'stdio';
  logger.info('Starting SpamTitan MCP server', {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeVersion: process.version,
  });

  if (transportType === 'http') {
    const { startHttpServer } = await import('./http.js');
    const httpServer = await startHttpServer();
    const shutdown = async () => {
      logger.info('Shutting down SpamTitan MCP server...');
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // stdio mode: single long-lived server, set server-ref for elicitation support.
  const server = createMcpServer();
  setServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SpamTitan MCP server running on stdio');
}

main().catch((error) => {
  logger.error('Fatal startup error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
