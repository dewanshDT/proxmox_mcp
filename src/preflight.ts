/**
 * Startup preflight — privilege model, the pure mismatch check, and the async
 * boot gate.
 *
 * This module implements [[Proxmox MCP Preflight]] steps 2-3: given the resolved
 * write-tool allowlist and the token's effective, role-collapsed ACL (as returned
 * by `GET /access/permissions`), work out which enabled write tools the token
 * cannot actually use.
 *
 * `PermissionsResponse`, `PrivRequirement`, `REQUIRED_PRIV` and `missingPrivileges`
 * are pure, side-effect-free values/functions (no env reads, no network, no
 * logging). `runPreflight` (PMX-M2-03) is the async part: it fetches the
 * permissions map and applies decision D7's refuse-boot / warn-and-continue
 * branching. It is not part of the `src/client` / `src/endpoints` SDK layer, so
 * it may import the client and config modules.
 */

import type { ProxmoxClient } from "./client/api.js";
import { ProxmoxApiError } from "./client/http.js";
import type { ServerConfig } from "./config.js";
import { resolveAllowlist } from "./mcp/tools.js";

/**
 * Upper bound on the `GET /access/permissions` probe. Well under the 30s HTTP
 * deadline and the ~10s undici connect timeout, so a down / unroutable
 * `PROXMOX_HOST` can't hold up `app.listen()` (and therefore `/health`) for the
 * full connect timeout. Mutable so tests can shrink it without fake timers —
 * mirrors `EXEC_POLL` in `src/mcp/tools.ts`.
 */
export const PREFLIGHT_PROBE = { timeoutMs: 5_000 };

/** Rejection used by {@link withProbeTimeout} when the probe outruns
 *  {@link PREFLIGHT_PROBE}.timeoutMs. Treated exactly like "unreachable" (D7). */
class PreflightTimeout extends Error {}

/**
 * Race a probe promise against {@link PREFLIGHT_PROBE}.timeoutMs. On timeout the
 * returned promise rejects with a {@link PreflightTimeout}; the still-pending
 * probe is swallowed so a late-settling reject can't become an unhandled
 * rejection.
 */
function withProbeTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreflightTimeout()), PREFLIGHT_PROBE.timeoutMs);
  });
  // swallow the loser so a late-settling probe can't become an unhandled rejection
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The shape of `GET /access/permissions`: ACL path -> privilege name -> propagation
 * flag (`1` = also applies to child paths, `0` = this path only). A privilege key
 * being present means it is granted. Defined structurally here rather than imported
 * from `src/types` so this module does not depend on PMX-M2-01 having landed;
 * matches `EffectivePermissions = Record<string, Record<string, 0 | 1>>`.
 */
export type PermissionsResponse = Record<string, Record<string, 0 | 1>>;

/**
 * A privilege requirement for one write tool.
 *
 * - `mode: "all"` — the token must hold *every* listed privilege.
 * - `mode: "any"` — the token needs *at least one* of the listed privileges
 *   (the Proxmox endpoint check is any-of).
 */
export interface PrivRequirement {
  privileges: readonly string[];
  mode: "all" | "any";
}

/**
 * The Proxmox privilege(s) each write tool needs, per the corrected
 * [[Proxmox MCP Preflight]] table. Keyed by *tool name*, not group: `delete` and
 * `rollback` are both `destructive` but need different privileges.
 *
 * - `exec` -> `VM.GuestAgent.Unrestricted` (PVE 9.0 removed `VM.Monitor`;
 *   `VM.GuestAgent.Audit` is read-only agent commands only — SPK-2).
 * - `snapshot_rollback` -> `VM.Snapshot` **or** `VM.Snapshot.Rollback`; both
 *   privileges exist on 9.1 and the endpoint check is any-of (SPK-4).
 */
export const REQUIRED_PRIV: Record<string, PrivRequirement> = {
  proxmox_guest_start: { privileges: ["VM.PowerMgmt"], mode: "all" },
  proxmox_guest_shutdown: { privileges: ["VM.PowerMgmt"], mode: "all" },
  proxmox_guest_reboot: { privileges: ["VM.PowerMgmt"], mode: "all" },
  proxmox_guest_stop: { privileges: ["VM.PowerMgmt"], mode: "all" },
  proxmox_snapshot_create: { privileges: ["VM.Snapshot"], mode: "all" },
  proxmox_snapshot_delete: { privileges: ["VM.Snapshot"], mode: "all" },
  proxmox_snapshot_rollback: {
    privileges: ["VM.Snapshot", "VM.Snapshot.Rollback"],
    mode: "any",
  },
  proxmox_guest_exec: { privileges: ["VM.GuestAgent.Unrestricted"], mode: "all" },
  proxmox_guest_exec_status: { privileges: ["VM.GuestAgent.Unrestricted"], mode: "all" },
};

/**
 * Collect the set of privileges the token effectively holds anywhere in its ACL.
 *
 * The permissions map's outer key is an ACL path and the inner key a privilege
 * that is granted at that path (value = propagation flag). For a homelab the
 * token is typically granted at `/` with propagation `1`, so any path's grant is
 * treated as sufficient: a privilege is "held" if it appears in *any* path's
 * inner map (granted directly at `/vms` or `/`, or propagated from an ancestor).
 */
function heldPrivileges(perms: PermissionsResponse): Set<string> {
  const held = new Set<string>();
  for (const byPriv of Object.values(perms)) {
    for (const priv of Object.keys(byPriv)) held.add(priv);
  }
  return held;
}

/**
 * Given the enabled write-tool names and the token's effective permissions
 * (path -> privilege -> propagation flag), return the tools whose required
 * privilege(s) are not satisfied at `/vms` or `/` (granted directly, or
 * propagated with flag `1` from an ancestor path).
 *
 * - `mode: "all"` — `missing` lists the required privileges not held; the tool
 *   is a finding when that list is non-empty.
 * - `mode: "any"` — the tool is a finding only when *none* of the required
 *   privileges are held; `missing` is then the full required list.
 *
 * Tools in `allow` with no `REQUIRED_PRIV` entry are skipped (shouldn't happen).
 */
export function missingPrivileges(
  allow: ReadonlySet<string>,
  perms: PermissionsResponse,
): Array<{ tool: string; missing: string[] }> {
  const held = heldPrivileges(perms);
  const findings: Array<{ tool: string; missing: string[] }> = [];

  for (const tool of allow) {
    const req = REQUIRED_PRIV[tool];
    if (!req) continue;

    if (req.mode === "all") {
      const missing = req.privileges.filter((priv) => !held.has(priv));
      if (missing.length > 0) findings.push({ tool, missing });
    } else {
      const satisfied = req.privileges.some((priv) => held.has(priv));
      if (!satisfied) findings.push({ tool, missing: [...req.privileges] });
    }
  }

  return findings;
}

/** Logged (to stderr) when the permission probe fails in a way that is not a
 *  hard "denied" — a 5xx, a transport reject, a timeout. Warn and boot anyway:
 *  a homelab must not be unable to restart its management server because a node
 *  is rebooting (decision D7, the bootstrap trap). */
const UNREACHABLE_LINE = "preflight: Proxmox unreachable, skipping permission check";

/**
 * Startup ACL gate (decision D7). Resolves the token's real, role-collapsed
 * permissions and checks every *enabled* write tool against the privilege(s) it
 * needs. Called from `main()` after `loadConfig()` and before `app.listen()`.
 *
 * Branching:
 *  - **Denied** — the probe returns a 2xx ACL that is missing an enabled tool's
 *    privilege, or a 401/403 (the Layer 2 credential is wrong): **throw**, so
 *    `main().catch` exits non-zero. The thrown message names each unmet tool and
 *    its required privilege(s).
 *  - **Unreachable** — the probe rejects with a transport error / timeout, or a
 *    `ProxmoxApiError` with status >= 500: log {@link UNREACHABLE_LINE} and
 *    return (warn and continue).
 *  - **No write tools enabled** — the probe still runs for the log line, but any
 *    failure of it (even a 401) only logs {@link UNREACHABLE_LINE} and returns;
 *    it never throws, because there is nothing to gate.
 */
export async function runPreflight(proxmox: ProxmoxClient, config: ServerConfig): Promise<void> {
  const allow = resolveAllowlist(config.writeTools);

  let perms: PermissionsResponse;
  try {
    // Query `/vms`, not `/`. Every write tool in REQUIRED_PRIV is a VM
    // operation, so `/vms` is the correct scope, and a `/vms` query is a
    // superset of a `/` query for our purposes: it returns privileges granted
    // directly at `/vms` (the DEPLOYMENT.md-recommended tighter scope) *and*
    // those propagated down from a `/`-level grant. A `/` query only returns
    // what is effective at `/` and misses a `/vms`-scoped write role, which
    // false-negatives preflight and refuses an otherwise-capable token's boot.
    perms = await withProbeTimeout(proxmox.access.permissions("/vms"));
  } catch (err) {
    // No write tools to gate: the probe is only for the log line here, so any
    // failure — 401 included — is warn-and-continue, never a refused boot.
    if (allow.size === 0) {
      console.error(UNREACHABLE_LINE);
      return;
    }
    // Probe outran PREFLIGHT_PROBE.timeoutMs: a form of "unreachable" (D7) — a
    // down / unroutable host that would otherwise block boot for the full undici
    // connect timeout. Warn and continue; never throw (not a ProxmoxApiError, so
    // it can't hit the 401/403 path below anyway — explicit here for clarity).
    if (err instanceof PreflightTimeout) {
      console.error(UNREACHABLE_LINE);
      return;
    }
    if (err instanceof ProxmoxApiError && (err.status === 401 || err.status === 403)) {
      throw new Error(
        `preflight: Proxmox token is invalid or cannot read its own permissions (HTTP ${err.status})`,
      );
    }
    // 5xx, or a non-ProxmoxApiError throw (network reject, "fetch failed",
    // timeout): transport-level / server-side failure — warn and boot.
    console.error(UNREACHABLE_LINE);
    return;
  }

  const missing = missingPrivileges(allow, perms);
  if (missing.length > 0) {
    const detail = missing
      .map((finding) => `${finding.tool} (needs ${finding.missing.join(" or ")})`)
      .join("; ");
    throw new Error(
      `preflight: the Proxmox token cannot use these enabled write tools — ${detail}. ` +
        "Grant the privileges or narrow PROXMOX_WRITE_TOOLS.",
    );
  }

  console.error(
    allow.size === 0
      ? "preflight: OK — no write tools enabled, nothing to check"
      : `preflight: OK — ${allow.size} write tool(s), ACL satisfied`,
  );
}
