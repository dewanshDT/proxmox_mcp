# Security Policy

`proxmox-mcp` holds credentials to a Proxmox VE cluster and exposes tools that can stop virtual machines and roll back snapshots. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/dewanshDT/proxmox_mcp/security/advisories/new) — the "Report a vulnerability" button on the repository's Security tab.

Please include: affected version or commit, a description of the issue, reproduction steps, and the impact you believe it has.

You can expect an acknowledgement within a few days. This is a hobby project maintained in spare time, so please be patient with fix timelines. Once a fix is released, credit will be given in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Security model

Understanding the design helps you judge what is and isn't a vulnerability. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full model.

There are two authentication layers:

1. **Client → server:** a bearer token (`MCP_AUTH_TOKEN`), compared in constant time. The server refuses to start if it is unset.
2. **Server → Proxmox:** a Proxmox API token sent as `PVEAPIToken=…`. This credential never leaves the server.

The effective blast radius is whatever the Proxmox API token was granted. Scope it with Proxmox ACL roles.

## Known and intentional design decisions

These are deliberate trade-offs, documented so they aren't reported as bugs. That said, if you can show one is exploitable in a way not described here, please do report it.

| Behaviour | Rationale |
|---|---|
| Serves plain HTTP, not HTTPS | Intended for trusted LAN/VPN use; TLS is delegated to a reverse proxy. The bearer token is the access control. |
| `PROXMOX_ALLOW_SELF_SIGNED=true` disables certificate verification toward Proxmox | Proxmox ships a self-signed certificate by default. The connection stays encrypted but is not authenticated, so it is vulnerable to an on-path attacker. Install a real certificate to avoid this. |
| `MCP_ALLOW_NO_AUTH=true` disables client authentication entirely | An explicit, opt-in escape hatch for isolated test networks. The startup log prints `NO AUTH`. |
| `GET /health` is unauthenticated | Needed for container and monitoring probes. It returns only `{"status":"ok"}` and no cluster information. |
| A single shared bearer token, no per-user identity | Scope matches a self-hosted homelab tool. There is no RBAC beyond `PROXMOX_READONLY` and the Proxmox ACL. |
| Tool errors return upstream Proxmox error text | Aids debugging. Error text may include node names or VM IDs, so treat the endpoint as trusted-audience-only. |

## Hardening recommendations

- Set a long random `MCP_AUTH_TOKEN` (`openssl rand -hex 32`) and rotate it periodically.
- Grant the Proxmox token the least privilege that works — start with `PVEAuditor`.
- Run with `PROXMOX_READONLY=true` unless you need the write tools.
- Do not expose the endpoint to the internet. Prefer a VPN (WireGuard/Tailscale); if you must expose it, put TLS in front.
- Keep `.env` out of version control (it is gitignored) and `chmod 600` it on shared hosts.
- Keep dependencies current and watch for Dependabot alerts.
