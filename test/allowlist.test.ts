import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAllowlist,
  WRITE_TOOL_GROUPS,
  WRITE_TOOLS,
} from "../src/mcp/tools.js";

// ---- PMX-M1-02: resolveAllowlist() expands group aliases and exact names ----

test("empty input resolves to an empty set", () => {
  const result = resolveAllowlist([]);
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test("group aliases expand to their member tool names (union)", () => {
  const result = resolveAllowlist(["lifecycle", "snapshot"]);
  assert.deepEqual(
    [...result].sort(),
    [
      "proxmox_guest_reboot",
      "proxmox_guest_shutdown",
      "proxmox_guest_start",
      "proxmox_snapshot_create",
    ].sort(),
  );
  assert.equal(result.size, 4);
});

test("'all' expands to every write-tool name across all groups (9 tools)", () => {
  const result = resolveAllowlist(["all"]);
  assert.deepEqual(
    [...result].sort(),
    [
      "proxmox_guest_start",
      "proxmox_guest_shutdown",
      "proxmox_guest_reboot",
      "proxmox_snapshot_create",
      "proxmox_guest_stop",
      "proxmox_snapshot_delete",
      "proxmox_snapshot_rollback",
      "proxmox_guest_exec",
      "proxmox_guest_exec_status",
    ].sort(),
  );
  assert.equal(result.size, 9);
});

test("'exec' resolves to both guest-exec tool names", () => {
  const result = resolveAllowlist(["exec"]);
  assert.deepEqual(
    [...result].sort(),
    ["proxmox_guest_exec", "proxmox_guest_exec_status"].sort(),
  );
});

test("an exact tool name resolves to just itself", () => {
  const result = resolveAllowlist(["proxmox_snapshot_rollback"]);
  assert.deepEqual([...result], ["proxmox_snapshot_rollback"]);
});

test("an unknown token throws an Error naming the offending token (D10)", () => {
  assert.throws(() => resolveAllowlist(["lifecycle", "bogus"]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /bogus/);
    return true;
  });
});

test("proxmox_guest_stop is NOT reachable via 'lifecycle' (D11)", () => {
  assert.ok(!resolveAllowlist(["lifecycle"]).has("proxmox_guest_stop"));
});

test("proxmox_guest_stop IS reachable via 'destructive', 'all', and its exact name (D11)", () => {
  assert.ok(resolveAllowlist(["destructive"]).has("proxmox_guest_stop"));
  assert.ok(resolveAllowlist(["all"]).has("proxmox_guest_stop"));
  assert.ok(resolveAllowlist(["proxmox_guest_stop"]).has("proxmox_guest_stop"));
});

test("a group alias mixed with an exact name unions both", () => {
  const result = resolveAllowlist(["snapshot", "proxmox_guest_stop"]);
  assert.deepEqual(
    [...result].sort(),
    ["proxmox_guest_stop", "proxmox_snapshot_create"].sort(),
  );
});

// ---- drift guard: WRITE_TOOL_GROUPS <-> WRITE_TOOLS ----

test("every WRITE_TOOLS row's name appears under its group in WRITE_TOOL_GROUPS", () => {
  for (const row of WRITE_TOOLS) {
    assert.ok(
      WRITE_TOOL_GROUPS[row.group].includes(row.name),
      `${row.name} (group ${row.group}) is missing from WRITE_TOOL_GROUPS`,
    );
  }
});

test("every non-exec name in WRITE_TOOL_GROUPS has a matching WRITE_TOOLS row", () => {
  const rowByName = new Map(WRITE_TOOLS.map((row) => [row.name, row.group]));
  for (const [group, names] of Object.entries(WRITE_TOOL_GROUPS)) {
    if (group === "exec") continue;
    for (const name of names) {
      assert.equal(
        rowByName.get(name),
        group,
        `${name} is listed under ${group} in WRITE_TOOL_GROUPS but has no such WRITE_TOOLS row`,
      );
    }
  }
});

test("the exec group has rows for both guest-exec tools (M4-02 + M4-03)", () => {
  assert.deepEqual(WRITE_TOOL_GROUPS.exec, [
    "proxmox_guest_exec",
    "proxmox_guest_exec_status",
  ]);
  assert.deepEqual(
    WRITE_TOOLS.filter((row) => row.group === "exec").map((row) => row.name),
    ["proxmox_guest_exec", "proxmox_guest_exec_status"],
  );
});
