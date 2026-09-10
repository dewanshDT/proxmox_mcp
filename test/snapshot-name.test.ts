import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotName } from "../src/mcp/tools.js";

// Invariant #6 / Safety §2 / D13: the shared snapshotName schema rejects any
// name that could traverse or otherwise escape the `{snapname}` URL segment in
// SnapshotsApi.delete()/rollback(), and accepts ordinary Proxmox snapshot names.

const REJECTED = ["../x", "a/b", "", "-x", ".", "..%2f..%2f"];
const ACCEPTED = ["pre-upgrade_1", "snap1"];

for (const name of REJECTED) {
  test(`snapshotName rejects ${JSON.stringify(name)}`, () => {
    assert.equal(snapshotName.safeParse(name).success, false);
  });
}

for (const name of ACCEPTED) {
  test(`snapshotName accepts ${JSON.stringify(name)}`, () => {
    assert.equal(snapshotName.safeParse(name).success, true);
  });
}
