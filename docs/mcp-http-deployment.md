# MCP HTTP Deployment

This document describes the production-style deployment used to expose `memory-lancedb-pro` as an OAuth-protected MCP endpoint for ChatGPT and other MCP clients.

## Topology

Public flow:

1. `https://memory.openvm067.space`
2. `nginx`
3. `mcp-auth-proxy` on `127.0.0.1:18080`
4. `memory-lancedb-pro` HTTP MCP server on `127.0.0.1:3099`

The raw MCP backend is not exposed directly to the internet.

## Backend Service

Run the MCP backend with a user systemd unit.

Suggested unit:

```ini
[Unit]
Description=memory-lancedb-pro MCP HTTP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/austin/Development/research/memory-lancedb-pro
ExecStart=/usr/bin/node /home/austin/Development/research/memory-lancedb-pro/src/mcp/server-http.mjs
Restart=always
RestartSec=5
Environment=HOME=/home/austin
Environment=PATH=/home/austin/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=MEMORY_LANCEDB_PRO_MCP_HOST=127.0.0.1
Environment=MEMORY_LANCEDB_PRO_MCP_PORT=3099
Environment=MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG=/home/austin/.openclaw/openclaw.json
Environment=MEMORY_LANCEDB_PRO_MCP_PLUGIN_ENTRY=memory-lancedb-pro
Environment=MEMORY_LANCEDB_PRO_MCP_DEFAULT_SCOPE=global
Environment=MEMORY_LANCEDB_PRO_MCP_ACCESS_MODE=all
EnvironmentFile=-/home/austin/.openclaw/secrets.env

[Install]
WantedBy=default.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now memory-lancedb-pro-mcp.service
```

Verify it:

```bash
curl -sS -i http://127.0.0.1:3099/health
curl -sS -i -X POST http://127.0.0.1:3099/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}'
```

## OAuth Proxy

Example `mcp-auth-proxy` compose configuration:

```yaml
services:
  mcp-auth-proxy:
    image: ghcr.io/sigbit/mcp-auth-proxy:latest
    container_name: mcp-auth-proxy
    restart: unless-stopped
    network_mode: host
    env_file:
      - .env
    environment:
      EXTERNAL_URL: https://memory.openvm067.space
      LISTEN: 127.0.0.1:18080
      NO_AUTO_TLS: "1"
      DATA_PATH: /data
      HTTP_STREAMING_ONLY: "1"
      AUTH_SESSION_MAX_AGE: "2592000"
    volumes:
      - ./data:/data
    command: ["http://127.0.0.1:3099"]
```

Recreate it after changing the backend target:

```bash
docker compose up -d
```

Verify it:

```bash
curl -sS -i http://127.0.0.1:18080/.well-known/oauth-protected-resource
curl -sS -i -X POST http://127.0.0.1:18080/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}'
```

Expected behavior:

- metadata endpoint returns `200 OK`
- `/mcp` returns `401 Unauthorized` until OAuth is completed

## nginx

For the `memory.openvm067.space` server block, proxy these locations to `127.0.0.1:18080`:

- `/mcp`
- `/sse`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/.well-known/jwks.json`
- `/.idp/`
- `/.auth/`

Example challenge header:

```nginx
location @memory_graphiti_oauth_challenge {
  add_header WWW-Authenticate 'Bearer realm="Memory MCP", resource_metadata="https://memory.openvm067.space/.well-known/oauth-protected-resource"' always;
  return 401;
}
```

Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Public Verification

Use the public domain after cutover:

```bash
curl -sS -i https://memory.openvm067.space/.well-known/oauth-protected-resource
curl -sS -i https://memory.openvm067.space/.well-known/oauth-authorization-server
curl -sS -i https://memory.openvm067.space/.well-known/jwks.json
curl -sS -i -X POST https://memory.openvm067.space/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}'
```

Expected behavior:

- metadata endpoints return `200 OK`
- `/mcp` returns `401 Unauthorized`
- `WWW-Authenticate` points at `https://memory.openvm067.space/.well-known/oauth-protected-resource`

## Notes

- This deployment uses the Phase 1 HTTP MCP server in `src/mcp/server-http.mjs`.
- The old `graphiti-search-fetch-adapter` backend on `127.0.0.1:19090` is not needed for this public domain after cutover.
- If you need rollback, repoint `mcp-auth-proxy` to the previous backend and revert the nginx memory vhost.
