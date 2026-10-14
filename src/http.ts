/**
 * Stateless HTTP transport for SpamTitan MCP.
 *
 * Each request creates a fresh Server + StreamableHTTPServerTransport so that
 * no server state is shared across tenants or requests.  Credentials are
 * scoped to the request lifetime via AsyncLocalStorage (runWithCredentials).
 *
 * SECURITY-CRITICAL invariant: sessionIdGenerator MUST remain undefined and
 * enableJsonResponse MUST remain true. This keeps the transport stateless
 * (one request → one response). Switching to a stateful/SSE transport would
 * let a long-lived connection serve later tool calls under a stale/foreign
 * credential context — re-review tenant isolation before changing this.
 *
 * HTTP transport fails closed (CWE-306). An empty CONDUIT_S2S_SECRET used to
 * skip the X-Gateway-S2S check. Startup now refuses to listen unless the
 * secret is set and is not a known placeholder. MCP_ALLOW_INSECURE_DEV=1 is
 * the only bypass for an empty secret: it logs a warning, does not enforce
 * S2S, and binds 127.0.0.1. A non-loopback MCP_HTTP_HOST is refused in that
 * mode. A known placeholder is refused even when the bypass is set.
 *
 * A real secret honors MCP_HTTP_HOST, including 0.0.0.0. When that variable
 * is unset the process keeps the historical 0.0.0.0 bind so container deploys
 * stay reachable. The secret value is never logged.
 *
 * Gateway mode requires X-SpamTitan-API-Key on every /mcp request and does
 * not fall back to SPAMTITAN_API_KEY. /health and /healthz stay
 * unauthenticated and do not read credentials. stdio does not use S2S auth.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createScopedMcpServer } from './server.js';
import { getCredentials, runWithCredentials, DEFAULT_BASE_URL } from './utils/client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

/** Public example values. A copied placeholder must not verify as a real secret. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const LOOPBACK_HOST = '127.0.0.1';

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. ' +
  'Local development only; do not expose this port.';

const S2S_UNAUTHORIZED = {
  error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const bare = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === '127';
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * Read at HTTP startup, not module load. The secret value is never logged.
 */
function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? '').trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === '1') {
    return { secret: '', insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST; unset stays
 * 0.0.0.0 so existing container deploys keep their bind.
 */
function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? '').trim();
  if (!insecureDev) {
    return configured || '0.0.0.0';
  }
  if (configured === '' || isLoopbackBindHost(configured)) {
    return LOOPBACK_HOST;
  }
  refuseStart(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET ` +
      `only listens on ${LOOPBACK_HOST}. MCP_HTTP_HOST=${configured} is not loopback. ` +
      `Unset MCP_HTTP_HOST or set it to ${LOOPBACK_HOST}.`,
  );
}

export async function startHttpServer(): Promise<Server> {
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveBindHost(insecureDev);
  if (insecureDev) {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    // Logged only after the loopback bind is accepted, so a refused
    // non-loopback host does not claim the server is starting.
    logger.error(INSECURE_DEV_WARNING);
  }
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Health check — shallow unauthenticated liveness probe.
    // Must NOT depend on credentials: in gateway mode credentials arrive
    // per-request via headers, so a credential check here would return 503
    // and cause container health checks to fail when no ambient key is set.
    // This handler must not read vendor credentials.
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        authMode: isGatewayMode ? 'gateway' : 'env',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise. A configured secret is always enforced, before any
    // credential extraction.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    // Gateway mode: extract and validate credentials from headers.
    // Reject explicitly if the API key is missing rather than falling through
    // — falling through would resolve SPAMTITAN_API_KEY from the process
    // environment, which is not request-scoped.
    if (isGatewayMode) {
      const apiKey = headerValue(req.headers['x-spamtitan-api-key']);
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Missing credentials',
          message: 'Gateway mode requires X-SpamTitan-API-Key header',
          required: ['X-SpamTitan-API-Key'],
        }));
        return;
      }

      // SpamTitan is self-hosted, so the instance URL is per-tenant and must
      // travel with the key. Optional for back-compat: absent, we fall back to
      // SPAMTITAN_BASE_URL / the TitanHQ default.
      const baseUrl = headerValue(req.headers['x-spamtitan-base-url'])
        || process.env.SPAMTITAN_BASE_URL
        || DEFAULT_BASE_URL;

      const handle = () => createScopedMcpServer(async (server) => {
        // SECURITY: sessionIdGenerator: undefined → stateless, one response per request.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      });

      await runWithCredentials({ apiKey, baseUrl }, handle);
      return;
    }

    // Env mode: credentials come from SPAMTITAN_API_KEY env var.
    // Validate that credentials exist before accepting the request.
    if (!getCredentials()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No credentials configured',
        message: 'Set SPAMTITAN_API_KEY environment variable',
      }));
      return;
    }

    await createScopedMcpServer(async (server) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off('error', onError);
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      logger.info(`SpamTitan MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? 'gateway (X-SpamTitan-API-Key header)' : 'env (SPAMTITAN_API_KEY environment variable)'}`);
      resolve();
    });
  });

  return httpServer;
}
