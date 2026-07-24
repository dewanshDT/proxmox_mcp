# proxmox-mcp

[![CI](https://github.com/dewanshDT/proxmox_mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dewanshDT/proxmox_mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

A self-hostable MCP server for [Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment/overview). Lets Claude (or any MCP client) inspect and manage your nodes, VMs, containers, snapshots, and storage over the Proxmox REST API.

It runs as a **networked HTTP server** — host one instance inside your homelab (e.g. a Docker container on or near the cluster) and every device on your LAN can point its MCP client at it. The container holds the Proxmox credentials; clients authenticate with a bearer token. Proxmox's `:8006` API traffic stays internal — only the MCP endpoint is exposed to clients.

> [!WARNING]
> With write tools enabled this server can **stop virtual machines and roll back snapshots**, discarding current state — and an LLM decides when to call them. Start with `PROXMOX_READONLY=true` and a `PVEAuditor` token, keep your client's per-tool approval prompts on, and maintain backups you don't depend on this tool to restore.

## Architecture

```
src/
  client/       Reusable Proxmox SDK — knows nothing about MCP
    http.ts       HTTP + token auth + { data } envelope handling
    api.ts        ProxmoxClient facade
  endpoints/    One module per API area: cluster, nodes, qemu, lxc,
                snapshots, storage, tasks
  mcp/
    tools.ts      Thin MCP tool layer over ProxmoxClient
  config.ts     Environment-based configuration
  index.ts      Express server exposing MCP over Streamable HTTP
```

```
┌──────────────┐  HTTP + Bearer   ┌──────────────┐  HTTPS :8006   ┌─────────────────────┐
│  MCP clients │ ───────────────► │  proxmox-mcp │ ─────────────► │  Proxmox cluster    │
│ (any device  │   /mcp on :3000  │  (container) │   API token    │  node1 / node2 /... │
│  on the LAN) │ ◄─────────────── │              │ ◄───────────── │  pveproxy on each   │
└──────────────┘                  └──────────────┘                └─────────────────────┘
```

The server speaks MCP over **Streamable HTTP** in stateless mode: each request is handled by a fresh server instance, so multiple clients stay isolated with no shared session state.

Every Proxmox write operation returns a task ID (UPID). Write tools poll the task to completion and return its final status, so results are definitive rather than fire-and-forget.

> **Deploying this?** See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full authentication model (both hops), a pre-deployment checklist, per-client connection instructions (Claude Code, Claude Desktop, OpenAI, Anthropic API, custom SDKs), and troubleshooting.

## Setup

### 1. Create a Proxmox user and API token

In the Proxmox shell (or via the UI under Datacenter → Permissions):

```sh
# Dedicated user
pveum user add mcp@pve

# API token (note the secret — it is shown only once)
pveum user token add mcp@pve homelab --privsep 0

# Read-only access:
pveum acl modify / --users mcp@pve --roles PVEAuditor
# ...or full control:
pveum acl modify / --users mcp@pve --roles Administrator
```

With `--privsep 1` (privilege separation), grant the ACL to the token itself (`--tokens 'mcp@pve!homelab'`) instead.

Because a Proxmox cluster shares its config across all nodes, this single token authenticates against the **whole cluster** — point the server at any one node and you can manage them all.

### 2. Deploy with Docker (recommended)

```sh
cp .env.example .env
# Edit .env: set PROXMOX_HOST / token, and a strong MCP_AUTH_TOKEN
#   openssl rand -hex 32   # to generate a token

docker compose up -d --build
docker compose logs -f      # confirm it started
curl http://localhost:3000/health   # -> {"status":"ok"}
```

Point `PROXMOX_HOST` at a **stable node or a cluster VIP** — that node is your single API entry point (see [Hosting in the homelab](#hosting-in-the-homelab)).

### Running without Docker

```sh
npm install
npm run build
MCP_AUTH_TOKEN=… PROXMOX_HOST=… PROXMOX_TOKEN_ID=… PROXMOX_TOKEN_SECRET=… npm start
```

### 3. Configure your MCP client

The server exposes MCP at `http://<host>:3000/mcp`. Clients authenticate with the bearer token from `MCP_AUTH_TOKEN`.

For Claude Code:

```sh
claude mcp add --transport http proxmox http://<host>:3000/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Or in `.mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "proxmox": {
      "type": "http",
      "url": "http://<host>:3000/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Repeat on every device — they all share the one server.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PROXMOX_HOST` | ✅ | Host or URL. `192.168.1.10` becomes `https://192.168.1.10:8006` |
| `PROXMOX_TOKEN_ID` | ✅ | Full token ID: `user@realm!tokenname` |
| `PROXMOX_TOKEN_SECRET` | ✅ | The token secret |
| `MCP_AUTH_TOKEN` | ✅ | Bearer token clients must send. Required unless `MCP_ALLOW_NO_AUTH=true` |
| `PROXMOX_ALLOW_SELF_SIGNED` | — | `true` to accept self-signed TLS certs (typical homelab) |
| `PROXMOX_READONLY` | — | `true` to register only read-only tools |
| `MCP_HTTP_PORT` | — | Port to listen on. Default `3000` |
| `MCP_HTTP_HOST` | — | Bind address. Default `0.0.0.0` |
| `MCP_ALLOW_NO_AUTH` | — | `true` to run without a bearer token (trusted networks only) |

## Hosting in the homelab

- **One entry point manages the whole cluster.** Every node runs `pveproxy` on `:8006` and shares config across the cluster. Point `PROXMOX_HOST` at any single node and `proxmox_cluster_resources` returns every node/VM/container; node-specific operations are proxied internally to the owning node.
- **Keep `:8006` internal.** Only the MCP endpoint (`:3000`) needs to be reachable by clients. The Proxmox API traffic never leaves your homelab network.
- **Reach it remotely** by placing clients and the server on the same VPN (Tailscale/WireGuard) rather than exposing anything to the internet.
- **Bootstrap/dependency caveat.** If you run this container on the very cluster it manages, don't make its own node your *only* path to the API — if that node goes down you lose remote management of the cluster. Prefer a stable node, mark the guest HA, or point `PROXMOX_HOST` at a different node / VIP.
- **Always require auth.** The write tools are destructive (stop VMs, roll back snapshots). Keep `MCP_AUTH_TOKEN` set; only use `MCP_ALLOW_NO_AUTH` on an isolated, trusted network.
- **TLS (optional).** The server speaks plain HTTP. For encryption + a hostname, put it behind a reverse proxy such as [Caddy](https://caddyserver.com/) which can terminate TLS and forward to `:3000`.

## Tools

**Read-only:** `proxmox_version`, `proxmox_cluster_status`, `proxmox_cluster_resources`, `proxmox_list_nodes`, `proxmox_node_status`, `proxmox_list_vms`, `proxmox_list_containers`, `proxmox_guest_status`, `proxmox_guest_config`, `proxmox_list_snapshots`, `proxmox_list_storage`, `proxmox_storage_content`, `proxmox_cluster_tasks`, `proxmox_task_status`, `proxmox_task_log`

**Write** (omitted when `PROXMOX_READONLY=true`): `proxmox_guest_start`, `proxmox_guest_shutdown`, `proxmox_guest_stop`, `proxmox_guest_reboot`, `proxmox_snapshot_create`, `proxmox_snapshot_delete`, `proxmox_snapshot_rollback`

`proxmox_cluster_resources` is the best entry point — one call returns every node, VM, container, and storage pool, including on standalone (non-clustered) installations.

## Development

```sh
npm run dev     # run from source with tsx
npm run build   # compile to dist/
```

The `src/client` + `src/endpoints` layers form a standalone Proxmox SDK with no MCP dependency — reusable for a CLI or dashboard.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, project layout, and how to add a new tool. A test suite is the most valuable thing the project is currently missing.

Please report security issues privately per [SECURITY.md](./SECURITY.md) rather than opening a public issue.

## License

[MIT](./LICENSE) © Dewansh

## Disclaimer

This is an **unofficial**, community-maintained project. It is not affiliated with, endorsed by, or sponsored by Proxmox Server Solutions GmbH. "Proxmox" is a registered trademark of Proxmox Server Solutions GmbH and is used here only to describe what this software interoperates with.

The software is provided "as is", without warranty of any kind, as set out in the [MIT License](./LICENSE). You are responsible for what it does to your infrastructure.
