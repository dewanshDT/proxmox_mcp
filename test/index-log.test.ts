import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAllowlist, writeToolSummary } from "../src/mcp/tools.js";

// ---- PMX-M1-05: the bind-log write summary (pure helper, no Express boot) ----

test("an empty allowlist summarises as [none]", () => {
  assert.equal(writeToolSummary(new Set()), "[none]");
});

test("the lifecycle allowlist summarises as its three names, sorted, no spaces", () => {
  assert.equal(
    writeToolSummary(resolveAllowlist(["lifecycle"])),
    "proxmox_guest_reboot,proxmox_guest_shutdown,proxmox_guest_start",
  );
});

test("the 'all' allowlist summarises as every resolved name, sorted, comma-joined", () => {
  const summary = writeToolSummary(resolveAllowlist(["all"]));
  const names = summary.split(",");

  assert.deepEqual(names, [...resolveAllowlist(["all"])].sort());
  assert.equal(names.length, 9);
  assert.equal(summary, [...names].sort().join(","));
  assert.ok(!summary.includes(" "), "no spaces in the summary");
});
