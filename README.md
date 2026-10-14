# SpamTitan MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for SpamTitan email security. Enables AI assistants to manage quarantine, maintain allowlists and blocklists, and view email filtering statistics.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects Claude (or any MCP-compatible AI) to your SpamTitan environment.

> **Part of the [MSP Claude Plugins](https://github.com/WYRE-AI) ecosystem** — a growing suite of AI integrations for the MSP stack. Built by MSPs, for MSPs.

## Installation

```bash
npm install @wyre-ai/spamtitan-mcp
```

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
|----------|----------|-------------|
| `SPAMTITAN_API_KEY` | For stdio and `AUTH_MODE=env` | SpamTitan API key |
| `SPAMTITAN_BASE_URL` | No | SpamTitan instance URL, including any path prefix (e.g. `https://mail.example.com/spamtitan/`). Defaults to `https://api-spamtitan.titanhq.com`. In gateway mode the per-request `X-SpamTitan-Base-URL` header takes precedence. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires `X-SpamTitan-API-Key` on each `/mcp` request and does not fall back to `SPAMTITAN_API_KEY`. `env` uses that variable only after S2S auth succeeds. Unset means `env` (stdio and single-tenant HTTP). |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `replace-me`, `your-s2s-secret`, `replace-with-a-real-secret`, and the other example values). Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses to start. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, the historical container bind. The image and Compose set `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-SpamTitan-API-Key: $SPAMTITAN_API_KEY" \
  -H "X-SpamTitan-Base-URL: $SPAMTITAN_BASE_URL" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-SpamTitan-API-Key`. That header is the only API-key source for the request. `X-SpamTitan-Base-URL` is optional and, when present, selects the tenant instance. `AUTH_MODE=env` still requires the signed `X-Gateway-S2S` header, then uses `SPAMTITAN_API_KEY` and `SPAMTITAN_BASE_URL` from the environment.

## Usage

### Running with Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spamtitan-mcp": {
      "command": "npx",
      "args": ["@wyre-ai/spamtitan-mcp"],
      "env": {
        "SPAMTITAN_API_KEY": "your-spamtitan-api-key"
      }
    }
  }
}
```

### Running with Claude Code (CLI)

```bash
claude mcp add spamtitan-mcp \
  -e SPAMTITAN_API_KEY=your-value \
  -- npx -y @wyre-ai/spamtitan-mcp
```

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, SpamTitan credentials arrive on each request as headers; the API key is not read from the environment.

```bash
docker build -t spamtitan-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  spamtitan-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset or empty. The gateway service sets `AUTH_MODE=gateway`, does not inject `SPAMTITAN_API_KEY` or `SPAMTITAN_BASE_URL`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SPAMTITAN_API_KEY` and `SPAMTITAN_BASE_URL`. It is separate from the gateway Compose service above.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SPAMTITAN_API_KEY=your-value \
  -e SPAMTITAN_BASE_URL=https://mail.example.com/spamtitan/ \
  -p 127.0.0.1:8080:8080 \
  spamtitan-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` (including the image default `0.0.0.0`) makes startup exit:

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Available Domains

### Lists
Manage allowlists and blocklists

### Quarantine
Email quarantine review and management

### Stats
Email filtering statistics and reports

## Features

- **Interactive quarantined-message card (MCP Apps, SEP-1865)** — `spamtitan_get_message` renders as a read-only interactive card in MCP Apps hosts (Claude Desktop/web); plain-JSON behavior is unchanged in other hosts. The card is neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`) — no rebuild needed. Rebuild the card bundle with `npm run build:ui` after editing `ui/`.

## Development

```bash
# Clone the repository
git clone https://github.com/WYRE-AI/spamtitan-mcp.git
cd spamtitan-mcp

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# HTTP refuses to start until CONDUIT_S2S_SECRET is a real secret
MCP_TRANSPORT=http CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" npm start

# Local HTTP only, without a service-to-service secret (binds 127.0.0.1)
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) if present, or open an issue to discuss changes.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
