import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAllowlist } from "../src/mcp/tools.js";
import {
  PREFLIGHT_PROBE,
  REQUIRED_PRIV,
  missingPrivileges,
  runPreflight,
} from "../src/preflight.js";
import { ProxmoxApiError } from "../src/client/http.js";
import type { ProxmoxClient } from "../src/client/api.js";
import type { ServerConfig } from "../src/config.js";

// ---- PMX-M2-02: REQUIRED_PRIV + missingPrivileges() ----
//
// missingPrivileges is pure: given the enabled write-tool names and the token's
// effective ACL (path -> privilege -> propagation flag), return the enabled
// tools whose required privilege(s) are not held anywhere in the map.

/** Every privilege named across REQUIRED_PRIV, granted at `/` with propagation. */
const ALL_GRANTED: Record<string, Record<string, 0 | 1>> = {
  "/": Object.fromEntries(
    [...new Set(Object.values(REQUIRED_PRIV).flatMap((r) => r.privileges))].map(
      (priv) => [priv, 1 as const],
    ),
  ),
};

test("all privileges granted at / + allow=all -> no findings", () => {
  const allow = resolveAllowlist(["all"]);
  assert.deepEqual(missingPrivileges(allow, ALL_GRANTED), []);
});

test("VM.PowerMgmt only + allow=lifecycle -> no findings", () => {
  const perms = { "/": { "VM.PowerMgmt": 1 as const } };
  const allow = resolveAllowlist(["lifecycle"]);
  assert.deepEqual(missingPrivileges(allow, perms), []);
});

test("VM.PowerMgmt only + allow=lifecycle,snapshot -> snapshot_create missing VM.Snapshot", () => {
  const perms = { "/": { "VM.PowerMgmt": 1 as const } };
  const allow = resolveAllowlist(["lifecycle", "snapshot"]);
  assert.deepEqual(missingPrivileges(allow, perms), [
    { tool: "proxmox_snapshot_create", missing: ["VM.Snapshot"] },
  ]);
});

test("any-of: VM.Snapshot.Rollback but not VM.Snapshot satisfies rollback", () => {
  const perms = { "/": { "VM.Snapshot.Rollback": 1 as const } };
  const allow = new Set(["proxmox_snapshot_rollback"]);
  assert.deepEqual(missingPrivileges(allow, perms), []);
});

test("any-of negative: neither VM.Snapshot nor VM.Snapshot.Rollback -> rollback is a finding", () => {
  const perms = { "/": { "VM.PowerMgmt": 1 as const } };
  const allow = new Set(["proxmox_snapshot_rollback"]);
  assert.deepEqual(missingPrivileges(allow, perms), [
    {
      tool: "proxmox_snapshot_rollback",
      missing: ["VM.Snapshot", "VM.Snapshot.Rollback"],
    },
  ]);
});

test("propagation: a grant in any path's map counts (perms keyed only at /)", () => {
  const perms = { "/": { "VM.PowerMgmt": 1 as const } };
  const allow = new Set([
    "proxmox_guest_start",
    "proxmox_guest_shutdown",
    "proxmox_guest_reboot",
    "proxmox_guest_stop",
  ]);
  assert.deepEqual(missingPrivileges(allow, perms), []);
});

test("propagation: grant at a deep path also counts (union across all paths)", () => {
  const perms = {
    "/vms/100": { "VM.PowerMgmt": 0 as const },
    "/storage": { "Datastore.Audit": 1 as const },
  };
  const allow = resolveAllowlist(["lifecycle"]);
  assert.deepEqual(missingPrivileges(allow, perms), []);
});

test("exec: token lacking VM.GuestAgent.Unrestricted -> proxmox_guest_exec is a finding", () => {
  const perms = { "/": { "VM.PowerMgmt": 1 as const } };
  const allow = new Set(["proxmox_guest_exec"]);
  assert.deepEqual(missingPrivileges(allow, perms), [
    { tool: "proxmox_guest_exec", missing: ["VM.GuestAgent.Unrestricted"] },
  ]);
});

test("tools in allow with no REQUIRED_PRIV entry are skipped", () => {
  const allow = new Set(["proxmox_not_a_real_tool"]);
  assert.deepEqual(missingPrivileges(allow, ALL_GRANTED), []);
});

test("empty allow -> no findings", () => {
  assert.deepEqual(missingPrivileges(new Set(), {}), []);
});

test("REQUIRED_PRIV: rollback is any-of, exec uses VM.GuestAgent.Unrestricted", () => {
  assert.equal(REQUIRED_PRIV.proxmox_snapshot_rollback.mode, "any");
  assert.deepEqual(REQUIRED_PRIV.proxmox_snapshot_rollback.privileges, [
    "VM.Snapshot",
    "VM.Snapshot.Rollback",
  ]);
  assert.deepEqual(REQUIRED_PRIV.proxmox_guest_exec.privileges, [
    "VM.GuestAgent.Unrestricted",
  ]);
  assert.equal(REQUIRED_PRIV.proxmox_snapshot_delete.mode, "all");
});

// ---- PMX-M2-03: runPreflight() — decision D7 branch behaviour ----
//
// runPreflight probes GET /access/permissions("/") through a ProxmoxClient and
// gates boot: denied (2xx missing a priv, or 401/403) -> throw; unreachable
// (5xx, or a transport reject) -> log + resolve; empty allowlist -> never throw.

/** A ServerConfig with only the fields runPreflight reads populated; the rest
 *  are dummies to satisfy the type. */
function makeConfig(writeTools: string[]): ServerConfig {
  return {
    proxmox: {
      host: "https://pve.example:8006",
      tokenId: "mcp@pve!preflight",
      tokenSecret: "00000000-0000-0000-0000-000000000000",
    },
    readonly: false,
    writeTools,
    http: { port: 3000, host: "0.0.0.0", authToken: "dummy" },
  };
}

/** A stub ProxmoxClient whose only live method is `access.permissions`. */
function stubClient(permissions: (path?: string) => Promise<unknown>): ProxmoxClient {
  return { access: { permissions } } as unknown as ProxmoxClient;
}

/** Run `fn`, capturing every `console.error` line; always restores it. */
async function captureError(
  fn: () => Promise<void>,
): Promise<{ lines: string[]; error?: unknown }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
    return { lines };
  } catch (error) {
    return { lines, error };
  } finally {
    console.error = original;
  }
}

const UNREACHABLE = "preflight: Proxmox unreachable, skipping permission check";

test("runPreflight: lifecycle enabled + VM.PowerMgmt granted -> resolves, logs OK", async () => {
  const { lines, error } = await captureError(() =>
    runPreflight(
      stubClient(async () => ({ "/": { "VM.PowerMgmt": 1 } })),
      makeConfig(["lifecycle"]),
    ),
  );
  assert.equal(error, undefined);
  assert.ok(
    lines.some((l) => l.startsWith("preflight: OK")),
    `expected an OK line, got: ${JSON.stringify(lines)}`,
  );
  assert.ok(!lines.includes(UNREACHABLE));
});

test("runPreflight: snapshot enabled but only VM.PowerMgmt granted -> rejects naming the tool + priv", async () => {
  const { error } = await captureError(() =>
    runPreflight(
      stubClient(async () => ({ "/": { "VM.PowerMgmt": 1 } })),
      makeConfig(["lifecycle", "snapshot"]),
    ),
  );
  assert.ok(error instanceof Error, "expected a thrown Error");
  assert.match(error.message, /proxmox_snapshot_create/);
  assert.match(error.message, /VM\.Snapshot/);
  assert.match(error.message, /PROXMOX_WRITE_TOOLS/);
});

test("runPreflight: permissions 401 + non-empty allow -> rejects, message says invalid / HTTP 401", async () => {
  const { error } = await captureError(() =>
    runPreflight(
      stubClient(async () => {
        throw new ProxmoxApiError("nope", 401, "GET", "/access/permissions");
      }),
      makeConfig(["lifecycle"]),
    ),
  );
  assert.ok(error instanceof Error, "expected a thrown Error");
  assert.match(error.message, /invalid|cannot read its own permissions/);
  assert.match(error.message, /HTTP 401/);
});

test("runPreflight: permissions 503 + non-empty allow -> resolves, logs unreachable", async () => {
  const { lines, error } = await captureError(() =>
    runPreflight(
      stubClient(async () => {
        throw new ProxmoxApiError("boom", 503, "GET", "/access/permissions");
      }),
      makeConfig(["lifecycle"]),
    ),
  );
  assert.equal(error, undefined);
  assert.ok(lines.includes(UNREACHABLE), `got: ${JSON.stringify(lines)}`);
});

test("runPreflight: permissions transport reject + non-empty allow -> resolves, logs unreachable", async () => {
  const { lines, error } = await captureError(() =>
    runPreflight(
      stubClient(async () => {
        throw new Error("fetch failed");
      }),
      makeConfig(["lifecycle"]),
    ),
  );
  assert.equal(error, undefined);
  assert.ok(lines.includes(UNREACHABLE), `got: ${JSON.stringify(lines)}`);
});

test("runPreflight: empty allowlist + permissions 401 -> resolves (never throws), logs unreachable", async () => {
  const { lines, error } = await captureError(() =>
    runPreflight(
      stubClient(async () => {
        throw new ProxmoxApiError("nope", 401, "GET", "/access/permissions");
      }),
      makeConfig([]),
    ),
  );
  assert.equal(error, undefined);
  assert.ok(lines.includes(UNREACHABLE), `got: ${JSON.stringify(lines)}`);
});

// ---- PMX-M4-04: exec in the preflight privilege map (verify + refuse-boot) ----
//
// M2-02 already added the proxmox_guest_exec / proxmox_guest_exec_status rows to
// REQUIRED_PRIV; this milestone verifies them and pins the exec refuse-boot path:
// `exec` enabled but the token lacks VM.GuestAgent.Unrestricted must refuse boot,
// naming the tool and the privilege.

test("PMX-M4-04: REQUIRED_PRIV rows for both exec tools = VM.GuestAgent.Unrestricted / all", () => {
  assert.deepEqual(REQUIRED_PRIV.proxmox_guest_exec, {
    privileges: ["VM.GuestAgent.Unrestricted"],
    mode: "all",
  });
  assert.deepEqual(REQUIRED_PRIV.proxmox_guest_exec_status, {
    privileges: ["VM.GuestAgent.Unrestricted"],
    mode: "all",
  });
});

test("PMX-M4-04: missingPrivileges — exec allowed, no perms granted -> exec is a finding", () => {
  const allow = new Set(["proxmox_guest_exec"]);
  assert.deepEqual(missingPrivileges(allow, {}), [
    { tool: "proxmox_guest_exec", missing: ["VM.GuestAgent.Unrestricted"] },
  ]);
});

test("PMX-M4-04: missingPrivileges — exec allowed, VM.GuestAgent.Unrestricted granted -> no findings", () => {
  const allow = new Set(["proxmox_guest_exec"]);
  const perms = { "/": { "VM.GuestAgent.Unrestricted": 1 as const } };
  assert.deepEqual(missingPrivileges(allow, perms), []);
});

test("PMX-M4-04: runPreflight — exec group enabled but agent priv absent -> refuses boot naming tool + priv", async () => {
  const { error } = await captureError(() =>
    runPreflight(
      stubClient(async () => ({ "/": { "VM.PowerMgmt": 1 } })),
      makeConfig(["exec"]),
    ),
  );
  assert.ok(error instanceof Error, "expected a thrown Error");
  assert.match(error.message, /proxmox_guest_exec/);
  assert.match(error.message, /VM\.GuestAgent\.Unrestricted/);
});

test("PMX-M4-04: runPreflight — exec group enabled + VM.GuestAgent.Unrestricted granted -> resolves, logs OK", async () => {
  const { lines, error } = await captureError(() =>
    runPreflight(
      stubClient(async () => ({ "/": { "VM.GuestAgent.Unrestricted": 1 } })),
      makeConfig(["exec"]),
    ),
  );
  assert.equal(error, undefined);
  assert.ok(
    lines.some((l) => l.startsWith("preflight: OK")),
    `expected an OK line, got: ${JSON.stringify(lines)}`,
  );
  assert.ok(!lines.includes(UNREACHABLE));
});

// ---- PMX-M2-05: the probe is bounded — a hung Proxmox can't block boot ----
//
// Against a down / unroutable PROXMOX_HOST, `permissions("/")` hangs for the full
// undici connect timeout before the "unreachable -> warn + continue" branch runs,
// delaying app.listen and /health. runPreflight now races the probe against
// PREFLIGHT_PROBE.timeoutMs and treats exceeding it exactly like "unreachable".

test("PMX-M2-05: permissions never settles -> runPreflight still resolves within the bound, logs unreachable", async () => {
  const savedTimeout = PREFLIGHT_PROBE.timeoutMs;
  PREFLIGHT_PROBE.timeoutMs = 10;
  try {
    const { lines, error } = await captureError(() =>
      runPreflight(
        stubClient(() => new Promise<never>(() => {})),
        makeConfig(["lifecycle"]),
      ),
    );
    assert.equal(error, undefined, "runPreflight must resolve, not reject");
    assert.ok(
      lines.includes(UNREACHABLE),
      `expected the unreachable line, got: ${JSON.stringify(lines)}`,
    );
  } finally {
    PREFLIGHT_PROBE.timeoutMs = savedTimeout;
  }
});

test("PMX-M2-05: a late-rejecting probe does not surface as an unhandled rejection", async () => {
  const savedTimeout = PREFLIGHT_PROBE.timeoutMs;
  PREFLIGHT_PROBE.timeoutMs = 10;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { error } = await captureError(() =>
      runPreflight(
        stubClient(
          () =>
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("late fetch failed")), 30);
            }),
        ),
        makeConfig(["lifecycle"]),
      ),
    );
    assert.equal(error, undefined);
    // give the late rejection time to fire and (not) propagate
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, [], `unexpected unhandled rejection(s): ${JSON.stringify(unhandled)}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    PREFLIGHT_PROBE.timeoutMs = savedTimeout;
  }
});
