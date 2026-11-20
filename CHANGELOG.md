## [Unreleased]

### Added

* **Interactive quarantined-message card via MCP Apps (SEP-1865).** New `spamtitan_get_message` tool fetches a single quarantined message by ID (`GET /api/v1/quarantine/messages/{id}` — same endpoint family the release/delete tools already use), and its results render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension) instead of a wall of JSON. The card shows sender, recipient, subject, quarantine reason, spam score, status, and received date. The card is READ-ONLY by policy: releasing or deleting a message stays a deliberate, model-mediated action — no in-card write buttons. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  * The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://spamtitan/message-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/message-card-html.ts`, committed), so it serves identically from stdio and the stateless per-request HTTP transport. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  * The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.
  * The card payload builder is best-effort: a payload that doesn't look like a quarantined message (or a builder failure) degrades to no card without affecting the tool result. Contract tests in `src/__tests__/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, the neutral-default/brand-injection behavior, and the card normalization.

### Security

* **credential-isolation:** Route each tenant to its own SpamTitan instance. The previous fix below moved the *API key* into request-scoped `AsyncLocalStorage`, but the base URL was left as a module-level `const` read from `process.env.SPAMTITAN_BASE_URL` once at import time, and `Credentials` carried only `apiKey`. SpamTitan is self-hosted, so the instance URL is per-tenant: in gateway mode every tenant's API key was therefore sent to whichever single host the container happened to boot with — one tenant's credential transmitted to another tenant's (or TitanHQ's) server. `baseUrl` is now a required field on `Credentials` and travels with the key.
  * `src/utils/client.ts` — `Credentials.baseUrl` added; module-level `SPAMTITAN_BASE_URL` const removed; `getCredentials()` resolves scoped store → `SPAMTITAN_BASE_URL` → exported `DEFAULT_BASE_URL`, read fresh per call.
  * `src/http.ts` — gateway mode reads the optional `X-SpamTitan-Base-Url` header (matching the fleet's `x-<vendor>-<discriminator>` convention, cf. `x-liongard-instance`) and passes it to `runWithCredentials()`. Absent, it falls back to env then the default, so existing single-tenant deployments are unaffected.
  * Tests — concurrent two-tenant routing assertion in `src/__tests__/client-url.test.ts`.

* **credential-isolation:** Close cross-tenant credential leak. The HTTP server previously constructed a single `Server` + `StreamableHTTPServerTransport` at module load (shared across all requests) and mutated `process.env.SPAMTITAN_API_KEY` per request to inject gateway credentials — a race condition that could serve one tenant's API key to a concurrent request from another tenant.
  * `src/server.ts` — new `createMcpServer()` factory; all `setRequestHandler` calls live inside the factory, never at module level.
  * `src/http.ts` — stateless per-request handler: fresh `Server` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` per request; `res.on('close', ...)` registered before `connect`; gateway credentials injected via `runWithCredentials()` (AsyncLocalStorage) instead of `process.env` mutation.
  * `src/utils/client.ts` — `AsyncLocalStorage<Credentials>` replaces the env-mutation approach; `runWithCredentials()` exported for the HTTP layer; `getCredentials()` reads scoped store first, falls back to env for stdio; `clearCredentials()` and singleton removed.
  * `src/index.ts` — dispatch only; no module-level `new Server()`; HTTP delegates to `src/http.ts`, stdio creates one server inside `main()`.
  * Tests — concurrent isolation test + per-request distinct server assertion added.

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

* **client:** Self-hosted instance URLs no longer lose their path prefix. `apiRequest()` built request URLs with `new URL(path, base)`, which performs RFC 3986 relative resolution rather than concatenation: because every call site passes a path-absolute reference (e.g. `/api/v1/stats`), the base URL's own path was discarded entirely. `SPAMTITAN_BASE_URL` is documented as "your SpamTitan instance URL" and SpamTitan is self-hosted, so any appliance served under a path prefix (e.g. `https://mail.example.com/spamtitan/`) had every request land on `/api/v1/...` instead of `/spamtitan/api/v1/...`. The bare-origin TitanHQ default is unaffected, which is why this was invisible by default. Base and path are now slash-normalized and joined explicitly. This also removes a sharper edge of the same bug: a path beginning with `//` is a *protocol-relative* reference, so `new URL('//api/v1/x', base)` resolved to the host `api` — sending the request to an entirely different server. Regression tests in `src/__tests__/client-url.test.ts` pin both host shapes.

* **health:** `/health` (and new `/healthz`) now return a shallow unauthenticated `200 {"status":"ok"}` and no longer depend on `getCredentials()`. In gateway mode credentials arrive per-request via headers, so the previous credential check returned `503`, failing the Azure liveness probe every 30s and crash-looping the `gwp-spamtitan` container.

## [1.1.1](https://github.com/wyre-technology/spamtitan-mcp/compare/v1.1.0...v1.1.1) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([1bae09f](https://github.com/wyre-technology/spamtitan-mcp/commit/1bae09ff1c54ff13b69da65d24a4b2db207a149e))

# [1.1.0](https://github.com/wyre-technology/spamtitan-mcp/compare/v1.0.0...v1.1.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([7823cb1](https://github.com/wyre-technology/spamtitan-mcp/commit/7823cb1a9f9abe71fb42860be3870661a07928d1))

# 1.0.0 (2026-03-02)


### Features

* initial SpamTitan MCP server scaffold ([569c9fd](https://github.com/wyre-technology/spamtitan-mcp/commit/569c9fd5a9af6a530c8980e1c6a36fc68762263e))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-03-02

### Added
- Initial release of SpamTitan MCP Server
- Decision-tree navigation architecture with three domains:
  - `quarantine`: List queue, release and delete quarantined messages
  - `lists`: Manage sender allowlists and blocklists
  - `stats`: View email flow statistics by time period and domain
- Dual transport support: stdio (Claude Desktop) and HTTP streaming (hosted deployment)
- Gateway auth mode: credentials injected via `X-SpamTitan-API-Key` header
- Health check endpoint at `/health`
- Docker image with non-root user and health check
- Structured stderr-only logging with configurable log level
- Comprehensive test suite with vitest
- Semantic release CI/CD pipeline
- MCPB manifest for Claude Desktop installation
