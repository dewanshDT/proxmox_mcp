import { test } from "node:test";
import assert from "node:assert/strict";
import { TasksApi } from "../src/endpoints/tasks.js";
import type { ProxmoxHttp } from "../src/client/http.js";
import type { TaskStatus } from "../src/types/index.js";

/**
 * waitForTask is what makes every write tool synchronous: the tool returns the
 * task's final result rather than a UPID. If it stops polling early, tools lie
 * about success; if it never stops, the MCP request hangs.
 */

const UPID = "UPID:pve:0004FABC:0AF3B2:6501:qmstart:100:root@pam:";

function stubbedTasks(sequence: Array<Partial<TaskStatus>>) {
  const calls: string[] = [];
  const http = {
    get: async (path: string) => {
      calls.push(path);
      return sequence[Math.min(calls.length - 1, sequence.length - 1)];
    },
  };
  return { api: new TasksApi(http as unknown as ProxmoxHttp), calls };
}

test("returns as soon as the task reports stopped", async () => {
  const { api, calls } = stubbedTasks([{ status: "stopped", exitstatus: "OK" }]);

  const result = await api.waitForTask("pve", UPID);

  assert.equal(result.exitstatus, "OK");
  assert.equal(calls.length, 1, "should not poll again once the task has stopped");
});

test("keeps polling while the task is still running", async () => {
  const { api, calls } = stubbedTasks([
    { status: "running" },
    { status: "running" },
    { status: "stopped", exitstatus: "OK" },
  ]);

  await api.waitForTask("pve", UPID, { pollIntervalMs: 1 });

  assert.equal(calls.length, 3);
});

test("a failed task still resolves — the caller inspects exitstatus", async () => {
  const { api } = stubbedTasks([{ status: "stopped", exitstatus: "command failed with exit code 1" }]);

  const result = await api.waitForTask("pve", UPID);

  assert.match(result.exitstatus ?? "", /exit code 1/);
});

test("gives up once the timeout elapses", async () => {
  const { api } = stubbedTasks([{ status: "running" }]);

  await assert.rejects(
    () => api.waitForTask("pve", UPID, { timeoutMs: 50, pollIntervalMs: 1 }),
    /Timed out after 50ms/,
  );
});

test("the UPID is URL-escaped into the path", async () => {
  const { api, calls } = stubbedTasks([{ status: "stopped", exitstatus: "OK" }]);

  await api.waitForTask("pve", UPID);

  assert.ok(calls[0].startsWith("/nodes/pve/tasks/"));
  assert.ok(calls[0].endsWith("/status"));
  assert.match(calls[0], /%3A/, "colons in the UPID must be escaped, not sent raw");
  assert.ok(!calls[0].includes("UPID:pve:"), "the raw UPID would break path parsing");
});

test("log and status hit the documented endpoints", async () => {
  const { api, calls } = stubbedTasks([{ status: "stopped" }]);

  await api.status("pve-II", UPID);
  await api.log("pve-II", UPID);
  await api.list("pve-III");

  assert.ok(calls[0].endsWith("/status"));
  assert.ok(calls[1].endsWith("/log"));
  assert.equal(calls[2], "/nodes/pve-III/tasks");
});
