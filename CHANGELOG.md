# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-10

### Added

- `PROXMOX_WRITE_TOOLS` — a per-tool write allowlist. Takes a comma-separated
  list of group aliases (`lifecycle`, `snapshot`, `destructive`, `exec`, `all`)
  and/or exact tool names; only the write tools it names are registered. An
  unknown entry makes the server refuse to start, naming the bad token.
- Startup permission preflight: before it listens, the server resolves the
  Proxmox token's effective ACL and checks every enabled write tool against the
  privilege it needs. A missing privilege (or an invalid token) refuses the
  boot, naming the tool; an unreachable Proxmox is logged and the server starts
  anyway (the probe is bounded to ~5 s so it never blocks `/health`).
- `proxmox_guest_exec` and `proxmox_guest_exec_status` — in-guest command
  execution via the QEMU guest agent. Both belong to the `exec` allowlist group
  (explicit `PROXMOX_WRITE_TOOLS` opt-in only; never enabled by the deprecation
  bridge) and need `VM.GuestAgent.Unrestricted` on the target VM, which the
  startup preflight enforces. QEMU only; `wait:false` returns the `pid` to poll
  with `proxmox_guest_exec_status`.

### Changed

- `PROXMOX_READONLY` is now the master off-switch: it forces the write set empty
  and overrides `PROXMOX_WRITE_TOOLS` (a warning is logged if both are set).
- Write access with no `PROXMOX_WRITE_TOOLS` set (and `PROXMOX_READONLY` unset or
  `false`) falls back to `lifecycle,snapshot` with a deprecation warning pointing
  at `PROXMOX_WRITE_TOOLS`. `destructive` and `exec` are never enabled by this
  bridge.
- Tool registration is now declarative — a `{ name, group }` table filtered by
  the resolved allowlist — replacing the ordered `if (readonly) return` guard.
- `waitForTask` returns a structured `{ done: false, upid, node }` result instead
  of throwing when a task outlives the 120 s poll ceiling; the write tools turn
  that into a non-error `{ status: "running", upid, ... }` result the caller
  polls with `proxmox_task_status`.
- The startup bind log now reports the resolved write allowlist
  (`write: <tool,tool,…>` or `write: [none]`) in place of `read-only` /
  `read-write`.

### Security

- `proxmox_snapshot_delete` and `proxmox_snapshot_rollback` now require an
  `expect_name` argument matching the target snapshot; a mismatch is refused
  before any Proxmox call.
- Snapshot-name validation is shared across `snapshot_create`,
  `snapshot_delete`, and `snapshot_rollback`, closing a path-traversal gap in
  delete and rollback.

[0.3.0]: https://github.com/dewanshDT/proxmox_mcp/compare/v0.2.0...v0.3.0
