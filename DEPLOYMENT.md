# Deployment Guide

Everything you need to know before putting `proxmox-mcp` into your homelab: how it authenticates, what to decide up front, and how to connect LLM clients to it.

For quick-start commands see [README.md](./README.md). This document covers the *why* and the edge cases.

---

## 1. The two-layer authentication model

There are **two independent authentication hops**. They use different credentials and protect different things. Getting this straight is the single most important thing before deploying.

```
┌──────────────┐                      ┌──────────────┐                    ┌──────────────┐
│  LLM client  │  ── Layer 1 ──────►  │  proxmox-mcp │ ── Layer 2 ─────►  │  Proxmox VE  │
│ (Claude/GPT) │  Authorization:      │  (container) │  Authorization:    │   :8006      │
│              │  Bearer <MCP_AUTH_   │              │  PVEAPIToken=      │              │
│              │         TOKEN>       │              │  user@realm!name=  │              │
│              │                      │              │  <secret>          │              │
└──────────────┘                      └──────────────┘                    └──────────────┘
     "who may ask this server to do things"      "what this server is allowed to do"
```

| | Layer 1 (client → MCP) | Layer 2 (MCP → Proxmox) |
|---|---|---|
| Credential | `MCP_AUTH_TOKEN` (a string you invent) | Proxmox API token (`PROXMOX_TOKEN_ID` + `PROXMOX_TOKEN_SECRET`) |
| Header | `Authorization: Bearer <token>` | `Authorization: PVEAPIToken=<id>=<secret>` |
| Set by | You, arbitrary | Proxmox, when you create the token |
| Protects | Access to the MCP endpoint | Nothing — it *grants* access to Proxmox |
| Scope control | All-or-nothing | Proxmox ACL roles + `PROXMOX_READONLY` / `PROXMOX_WRITE_TOOLS` (§2.3) |

**The critical consequence:** the Proxmox credential lives *only* on the server. Client devices never see it — they only hold the Layer 1 bearer token. That is the main security benefit of hosting this centrally. But it also means **anyone who has the Layer 1 token has whatever power the Layer 2 token was granted.** Scope the Proxmox role accordingly (§2.3).

---

## 2. Layer 2 — how the server authenticates to Proxmox

### 2.1 How it works in code

`src/client/http.ts` builds the credential once at construction and sends it on every request:

```ts
this.baseUrl    = config.host.replace(/\/+$/, "") + "/api2/json";
this.authHeader = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
```

That header goes on every call (`http.ts:68`). There is **no login/session step** — Proxmox API tokens are stateless, so there is no ticket to refresh, no cookie, and no CSRF token to manage. This is why tokens are used instead of username/password: password auth would require the `/access/ticket` flow, a 2-hour ticket refresh loop, and a `CSRFPreventionToken` header on every write.

### 2.2 Creating the token

```sh
pveum user add mcp@pve
pveum user token add mcp@pve homelab --privsep 0
```

The secret is displayed **once**. If you lose it, delete and recreate the token.

- `PROXMOX_TOKEN_ID` must be the **full** ID including the realm and token name: `mcp@pve!homelab`.
- The `!` is significant. In a shell, always single-quote it (`'mcp@pve!homelab'`) or bash history-expansion will mangle it. In `.env` files no quoting is needed.

**Privilege separation (`--privsep`):**

| | Behaviour | Grant ACL to |
|---|---|---|
| `--privsep 0` | Token inherits the user's permissions | the user: `--users mcp@pve` |
| `--privsep 1` | Token has its own, separate permissions | the token: `--tokens 'mcp@pve!homelab'` |

A very common deployment failure is using `--privsep 1` (the default in some Proxmox versions) and then granting the ACL only to the user — the token ends up with **zero** permissions and every call returns 403.

### 2.3 Choosing the permission scope

Grant the least privilege that meets your needs:

```sh
# Read-only — safe default for a first deployment
pveum acl modify / --users mcp@pve --roles PVEAuditor

# Full control — required for start/stop/snapshot tools
pveum acl modify / --users mcp@pve --roles Administrator
```

`PVEVMAdmin` is a good middle ground: it permits guest lifecycle and snapshot operations without granting datacenter-wide administration.

You can also scope by path instead of `/` — e.g. `pveum acl modify /vms/100 ...` limits the token to a single VM.

**Defence in depth.** Two server-side gates sit *under* the Proxmox ACL:

- **`PROXMOX_WRITE_TOOLS`** is the per-tool gate. It takes a comma-separated list of group aliases (`lifecycle`, `snapshot`, `destructive`, `exec`, `all`) and/or exact tool names; only the write tools it names get registered. An unknown or misspelled entry makes the server **refuse to boot**, naming the bad token, rather than starting with a silently narrower set. Left unset with `PROXMOX_READONLY` off, it falls back to `lifecycle,snapshot` and logs a deprecation warning — `destructive` and `exec` are never enabled implicitly.
- **`PROXMOX_READONLY=true`** is the master off-switch. It forces the write set empty and overrides `PROXMOX_WRITE_TOOLS` (a warning is logged if both were set), so one variable still disables every write tool.

Both are separate controls from the Proxmox ACL. Use them together — the ACL is the real boundary (it cannot be bypassed by a server misconfiguration), while `PROXMOX_WRITE_TOOLS` and `PROXMOX_READONLY` guard against an over-privileged token being misused.

### 2.4 The token is cluster-wide

Proxmox replicates `/etc/pve` across all cluster nodes via `pmxcfs`/corosync. A token created on **any** node authenticates against **every** node. You therefore configure exactly one `PROXMOX_HOST`, and the server can manage the whole cluster — node-specific requests are proxied internally by `pveproxy` to the owning node.

### 2.5 TLS

`PROXMOX_ALLOW_SELF_SIGNED=true` installs an undici `Agent` with `rejectUnauthorized: false` (`http.ts:46`), disabling certificate verification for the Proxmox connection.

This is normal for a homelab (Proxmox ships a self-signed cert) but it does mean the connection is **encrypted but not authenticated** — it is vulnerable to an on-path attacker. On a trusted LAN this is an acceptable trade-off. To do it properly, install a real certificate on Proxmox (Let's Encrypt via ACME, or your own internal CA) and leave `PROXMOX_ALLOW_SELF_SIGNED` unset.

### 2.6 Timeouts

| Setting | Value | Where |
|---|---|---|
| Overall per-request deadline | 30 s | `src/client/http.ts:44` |
| TCP connect timeout | ~10 s | undici default (not configured here) |
| Write-task poll timeout | 120 s | `src/endpoints/tasks.ts:33` |
| Poll interval | 1 s | `src/endpoints/tasks.ts:34` |

Note the two distinct timeouts: an unreachable `PROXMOX_HOST` fails at the **connect** stage after ~10 s, well before the 30 s overall deadline. A host that accepts the connection but responds slowly gets the full 30 s.

Write tools poll the Proxmox task before returning, so a slow VM shutdown can hold the HTTP response open for up to 120 s (the poll ceiling in the table above). Hitting that ceiling is **not** an error: the tool returns a normal result of the form `{"status":"running","upid":"…","node":"…","hint":"poll proxmox_task_status"}` — the Proxmox task is still alive, and the caller polls `proxmox_task_status` with that UPID until it stops. Any reverse proxy in front of the server still needs a read timeout above 120 s or it will cut that response short.

---

## 3. Layer 1 — how LLM clients authenticate to the server

### 3.1 How it works

`MCP_AUTH_TOKEN` is compared against the request's `Authorization: Bearer …` header using `crypto.timingSafeEqual` (a constant-time compare, so the check does not leak the token through response timing). A mismatch or missing header returns `401`.

### 3.2 It is mandatory by design

`loadConfig()` **throws on startup** if `MCP_AUTH_TOKEN` is unset. The server will not boot. This is deliberate: the write tools can stop VMs and roll back snapshots (destroying current state), so an unauthenticated endpoint on your LAN is a genuine hazard.

The escape hatch `MCP_ALLOW_NO_AUTH=true` exists for isolated test networks only. When used, the startup log prints `NO AUTH` so it is obvious.

### 3.3 Generating a token

```sh
openssl rand -hex 32
```

Treat it like a password. Rotate by changing `.env` and restarting (`docker compose up -d`); every client must then be updated.

### 3.4 What is *not* authenticated

`GET /health` is intentionally open so container/monitoring probes work. It returns only `{"status":"ok"}` and exposes no cluster information.

---

## 4. Pre-deployment checklist

### Placement — where to run the container

- **The bootstrap trap.** If the container runs on the same cluster it manages, and you point `PROXMOX_HOST` at that same node, then losing that node loses both the guest *and* your remote management path. Mitigate by pointing `PROXMOX_HOST` at a different node or a VIP, marking the guest HA, or hosting the container off-cluster entirely (a Raspberry Pi or NAS works well).
- **Pick a stable entry point.** `PROXMOX_HOST` is a single address. If that node is down, the API is unreachable even though the rest of the cluster is healthy. A keepalived VIP or a DNS name you can repoint solves this; the server has no built-in multi-host failover.

### Network

- Clients need to reach the MCP port (default `3000`). Only that port needs exposure.
- **Keep `:8006` internal.** Nothing outside the homelab should need to reach the Proxmox API directly.
- For remote access, put clients and the server on the same VPN (Tailscale / WireGuard) rather than port-forwarding to the internet.

### Secrets

- `.env` is already listed in `.gitignore` — never commit it. Use `.env.example` as the template.
- On a multi-user host, `chmod 600 .env`.
- Anyone with `docker inspect` access on the host can read the environment variables. For stricter setups use Docker secrets or a secrets manager.

### Safety

- **Deploy read-only first.** Set `PROXMOX_READONLY=true` and a `PVEAuditor` token, confirm everything works, then decide whether to grant write access.
- Understand the destructive tools: `proxmox_snapshot_rollback` discards current state, `proxmox_guest_stop` is a hard power-cut. An LLM can invoke these. Most clients ask for approval per tool call — keep that on. `proxmox_snapshot_delete` and `proxmox_snapshot_rollback` additionally require an `expect_name` that must match the target snapshot name, so a wrong `name` from a confused model is caught by the server before any request is sent; per-tool client approval is still the run-time gate.
- Have backups independent of this server.

### In-guest execution (`guest_exec`)

The `exec` group adds `proxmox_guest_exec` and `proxmox_guest_exec_status`, which run a command **inside a QEMU VM** through the guest agent — not on the Proxmox host. This is arbitrary code execution in the guest, the highest-blast-radius capability in the server, so gate it tightly:

- **Opt-in only.** Enable with `PROXMOX_WRITE_TOOLS=...,exec`. The deprecation bridge never includes it, and `PROXMOX_READONLY=true` still overrides it.
- **QEMU only.** The QEMU guest agent must be installed and running in the target VM. An LXC target is refused (`guest_exec supports QEMU VMs only`) before any Proxmox call — LXC in-guest exec is out of scope.
- **Needs `VM.GuestAgent.Unrestricted`** on the target. The startup preflight refuses to boot if `exec` is enabled and the token's ACL lacks it. Scope that grant to the guests you actually need — `pveum acl modify /vms/100 --users mcp@pve --roles ...` rather than `/`.
- **Keep per-tool approval on.** There is no `expect_name`-style guardrail — a command string has no target name to match — so the client's per-call confirmation is the run-time check.
- **Long commands.** `proxmox_guest_exec` polls on the same 1s / 120s contract as the other write tools. Pass `wait:false` to get the `pid` back immediately, then poll `proxmox_guest_exec_status` with `{ node, vmid, pid }` for the exit status and captured stdout/stderr. Hitting the 120s ceiling is not an error — it returns `{"status":"running","pid":...}`.

### Operations

- The container logs to stderr; `docker compose logs -f` shows the bind line and any request errors.
- `restart: unless-stopped` is set in `docker-compose.yml`, so it survives host reboots.
- Rebuild after pulling changes: `docker compose up -d --build`.

### TLS (optional)

The server speaks plain HTTP. On a trusted LAN that is usually fine — the bearer token is the access control. If you want encryption in transit, front it with a reverse proxy (Caddy makes this near-automatic) and remember to raise the proxy's read timeout above 120 s (§2.6).

---

## 5. Connecting LLM clients

### 5.1 The contract

Any MCP client that supports **Streamable HTTP** can connect:

| | |
|---|---|
| Endpoint | `http://<host>:3000/mcp` |
| Method | `POST` (GET/DELETE return `405` — stateless mode has no sessions) |
| Auth header | `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| Accept header | `application/json, text/event-stream` |

The server is **stateless**: each request is handled by a fresh instance, so there is no session to establish and multiple clients never interfere with each other.

### 5.2 ⚠️ Where the client runs determines whether a LAN address works

This is the most common source of confusion when connecting a hosted model.

| Client | Runs where | Can reach a private LAN IP? |
|---|---|---|
| Claude Code (CLI) | Your machine | ✅ Yes |
| Claude Desktop | Your machine | ✅ Yes |
| Any self-hosted / SDK client | Wherever you run it | ✅ Yes |
| OpenAI Responses API (hosted MCP) | **OpenAI's servers** | ❌ No — needs a public URL |
| ChatGPT connectors | **OpenAI's servers** | ❌ No — needs a public URL |

Locally-running clients connect straight to `http://192.168.1.x:3000/mcp`. **Hosted** clients call your server *from the provider's infrastructure*, so a private address is unreachable. To use those you must expose the endpoint publicly (a tunnel such as Cloudflare Tunnel or ngrok, or a reverse proxy with a real domain) — and at that point you should absolutely add TLS, since the bearer token would otherwise cross the internet in clear text. For a homelab that manages VMs, think carefully before doing this; a locally-running client is the safer architecture.

### 5.3 Claude Code

```sh
claude mcp add --transport http proxmox http://192.168.1.50:3000/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"

claude mcp list          # verify it connects
```

Remove with `claude mcp remove proxmox`.

### 5.4 Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "proxmox": {
      "type": "http",
      "url": "http://192.168.1.50:3000/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Restart Claude Desktop afterwards. Config file locations:
- macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows `%APPDATA%\Claude\claude_desktop_config.json`

If your Claude Desktop build does not accept a custom `headers` block, use the `mcp-remote` bridge, which adapts a remote HTTP server into a stdio server:

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://192.168.1.50:3000/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

### 5.5 OpenAI (Responses API)

The Responses API accepts an MCP server as a tool. **Requires a publicly reachable URL** (§5.2).

```python
from openai import OpenAI
client = OpenAI()

resp = client.responses.create(
    model="gpt-5",
    tools=[{
        "type": "mcp",
        "server_label": "proxmox",
        "server_url": "https://proxmox-mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer <MCP_AUTH_TOKEN>"},
        "require_approval": "always",
    }],
    input="Which VMs are currently running?",
)
print(resp.output_text)
```

Keep `require_approval: "always"` when write tools are enabled — it forces a confirmation step before the model can stop a VM or roll back a snapshot.

### 5.6 Anthropic API (MCP connector)

```python
import anthropic
client = anthropic.Anthropic()

resp = client.beta.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    messages=[{"role": "user", "content": "Summarise cluster health"}],
    mcp_servers=[{
        "type": "url",
        "url": "https://proxmox-mcp.example.com/mcp",
        "name": "proxmox",
        "authorization_token": "<MCP_AUTH_TOKEN>",
    }],
    betas=["mcp-client-2025-04-04"],
)
```

Same reachability rule as OpenAI — this call is made from Anthropic's servers, so the URL must be public.

### 5.7 Custom / self-hosted clients

Any MCP SDK works. TypeScript example:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://192.168.1.50:3000/mcp"),
  { requestInit: { headers: { Authorization: "Bearer <MCP_AUTH_TOKEN>" } } },
);

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);
console.log(await client.listTools());
```

Because these run on your own infrastructure, a LAN address is fine.

### 5.8 Suggested first prompt

`proxmox_cluster_resources` returns every node, VM, container and storage pool in one call — the cheapest way for a model to orient itself. Good openers:

- "What VMs are running across my cluster?"
- "Which node has the most free memory?"
- "Snapshot VM 100 before I upgrade it."

Deleting or rolling back a snapshot requires naming it twice — both `name` and a matching `expect_name` — or the server refuses the call.

---

## 6. Verifying a deployment

Run these from a **client** machine, replacing the host:

```sh
# 1. Reachable and healthy
curl http://192.168.1.50:3000/health
# -> {"status":"ok"}

# 2. Auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.1.50:3000/mcp
# -> 401

# 3. Full handshake + tool list
curl -s -X POST http://192.168.1.50:3000/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# -> 19 read tools + the write tools enabled by PROXMOX_WRITE_TOOLS

# 4. End-to-end through to Proxmox
curl -s -X POST http://192.168.1.50:3000/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"proxmox_version","arguments":{}}}'
# -> your Proxmox version
```

Step 3 passing but step 4 failing means the MCP layer is fine and the problem is Layer 2 (Proxmox credentials or reachability).

Proxmox and network failures are returned as normal MCP tool errors — `{"content":[{"type":"text","text":"…"}],"isError":true}` — rather than crashing the server, so the text in that field is your primary diagnostic. The server stays up and keeps serving other clients.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits: `Missing MCP_AUTH_TOKEN` | Expected — set it, or `MCP_ALLOW_NO_AUTH=true` |
| Server exits: `Missing required environment variable PROXMOX_…` | `.env` not loaded, or `env_file` missing in compose |
| `401` from `/mcp` | Wrong/absent bearer token, or header not `Bearer <token>` |
| `405` from `/mcp` | Used GET/DELETE — the endpoint is POST-only |
| Tool returns `401 authentication failure` | Bad `PROXMOX_TOKEN_ID`/`SECRET`, or ID missing the `!tokenname` part |
| Tool returns `403 Permission check failed` | ACL not granted — classically `--privsep 1` with the ACL on the user instead of the token (§2.2) |
| Tool returns `fetch failed (self-signed certificate)` | Set `PROXMOX_ALLOW_SELF_SIGNED=true` |
| Tool returns `fetch failed (Connect Timeout Error … :8006)` | Container cannot reach Proxmox `:8006` — firewall/routing/wrong host |
| Tool returns `fetch failed (ECONNREFUSED)` | Host reachable but nothing listening on `:8006` |
| Write tool returns `{"status":"running","upid":"…"}` instead of a final result | Expected — the task outlived the 120 s poll ceiling and is still running. Poll `proxmox_task_status` with that UPID (or watch it in the Proxmox UI) until it stops |
| Client shows no tools | Confirm with curl step 3; if that works, the client config is at fault |
