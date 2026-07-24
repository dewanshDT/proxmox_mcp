## What does this change?

<!-- A short description, and why it's needed. Link any related issue. -->

## Type of change

- [ ] Bug fix
- [ ] New tool / feature
- [ ] Documentation
- [ ] Build, CI, or packaging

## Testing

- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Smoke-tested the running server (`/health`, `tools/list`)
- [ ] Tested against a real Proxmox instance — version: <!-- e.g. 8.2.2 -->

<!-- Describe what you actually exercised. -->

## Checklist

- [ ] Any new environment variable is in `.env.example` and the README env table
- [ ] Any new tool is listed in the README and registered on the correct side of the `readonly` guard
- [ ] Docs updated if deployment or configuration behaviour changed
- [ ] No secrets, tokens, or real hostnames in the diff
