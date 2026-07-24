# Contributing

Thanks for your interest in improving `proxmox-mcp`.

## Getting set up

```sh
git clone https://github.com/dewanshDT/proxmox_mcp.git
cd proxmox_mcp
npm install
cp .env.example .env    # fill in your Proxmox details
npm run dev             # run from source with tsx
```

You need a Proxmox VE instance to test against. A single non-clustered node is enough for most work — `proxmox_cluster_resources` works on standalone installs too.

**Test read-only first.** Set `PROXMOX_READONLY=true` and use a `PVEAuditor` token while developing, so a mistake cannot stop a VM.

## Project layout

```
src/
  client/       Proxmox SDK — no MCP dependency
    http.ts       HTTP + token auth + { data } envelope
    api.ts        ProxmoxClient facade
  endpoints/    One module per API area (cluster, nodes, qemu, lxc, …)
  mcp/tools.ts  MCP tool layer over ProxmoxClient
  config.ts     Environment configuration
  index.ts      Express server (Streamable HTTP transport)
```

The `client/` and `endpoints/` layers deliberately know nothing about MCP — keep it that way so they stay reusable as a plain Proxmox SDK.

## Adding a tool

1. Add the API call to the relevant module in `src/endpoints/`, returning a typed result. Add types to `src/types/index.ts`.
2. Register the tool in `src/mcp/tools.ts`. Wrap the handler in the existing `safe()` helper so errors surface as tool errors instead of crashing the server.
3. If it is a **write** operation, register it after the `if (options.readonly) return;` guard and run it through `runTask()` so the Proxmox task is polled to completion.
4. Document it in the README tool list.

Use the existing `node`, `vmid`, and `guestType` Zod schemas at the top of `tools.ts` for consistent parameter descriptions.

## Before opening a pull request

```sh
npm run build     # must compile clean
npx tsc --noEmit  # strict typecheck
```

Then smoke-test the server end to end:

```sh
curl http://localhost:3000/health
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Style

- TypeScript strict mode; no `any` without a comment explaining why.
- Match the surrounding code — comment density, naming, and structure.
- Comments should explain *why*, not restate the code.
- Keep the MCP layer thin; business logic belongs in `endpoints/`.

## Pull requests

- One logical change per PR.
- Explain what changed and why. If it affects deployment or configuration, update `README.md` and `DEPLOYMENT.md` in the same PR.
- New environment variables must be added to `.env.example` and the README env table.
- Note whether you tested against a real Proxmox instance, and which version.

## Especially welcome

- **A test suite.** There is currently none — this is the biggest gap. Unit tests for `src/client/http.ts` (envelope parsing, error mapping, parameter encoding) would be a great start.
- Additional Proxmox coverage: VM create/clone/delete, migration, backup (vzdump) triggers.
- Multi-host failover for `PROXMOX_HOST`.
- Documentation fixes — including typos.

## Reporting bugs

Use the issue templates. For anything security-related, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
