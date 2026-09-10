import { test } from "node:test";
import assert from "node:assert/strict";
import { QemuApi } from "../src/endpoints/qemu.js";
import type { ProxmoxHttp } from "../src/client/http.js";
import type { AgentExecStatus } from "../src/types/index.js";

/**
 * guest_exec goes through the QEMU guest agent: agentExec POSTs argv as a
 * repeated `command` param and returns a PID, agentExecStatus GETs the result
 * by that PID. These stub http entirely and assert the exact path + params.
 */

type Call = { method: "get" | "post"; path: string; params?: Record<string, unknown> };

function stubbedQemu(resolved: unknown = null) {
  const calls: Call[] = [];
  const http = {
    get: async (path: string, params?: Record<string, unknown>) => {
      calls.push({ method: "get", path, params });
      return resolved;
    },
    post: async (path: string, params?: Record<string, unknown>) => {
      calls.push({ method: "post", path, params });
      return resolved;
    },
  };
  return { api: new QemuApi(http as unknown as ProxmoxHttp), calls };
}

test("agentExec POSTs /agent/exec with command as an array and no input-data", async () => {
  const { api, calls } = stubbedQemu({ pid: 123 });

  await api.agentExec("pve", 100, ["echo", "hi"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "post");
  assert.equal(calls[0].path, "/nodes/pve/qemu/100/agent/exec");
  assert.deepEqual(calls[0].params!.command, ["echo", "hi"]);
  assert.equal(calls[0].params!["input-data"], undefined);
});

test("agentExec forwards input as input-data", async () => {
  const { api, calls } = stubbedQemu({ pid: 7 });

  await api.agentExec("pve", 100, ["cat"], "stdin text");

  assert.equal(calls[0].path, "/nodes/pve/qemu/100/agent/exec");
  assert.deepEqual(calls[0].params!.command, ["cat"]);
  assert.equal(calls[0].params!["input-data"], "stdin text");
});

test("agentExecStatus GETs /agent/exec-status with the pid as a param", async () => {
  const { api, calls } = stubbedQemu({ exited: 0 });

  await api.agentExecStatus("pve-II", 100, 4242);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "get");
  assert.equal(calls[0].path, "/nodes/pve-II/qemu/100/agent/exec-status");
  assert.equal(calls[0].params!.pid, 4242);
});

test("agentExecStatus passes the http response straight through", async () => {
  const status: AgentExecStatus = {
    exited: 1,
    exitcode: 0,
    "out-data": "hello\n",
    "err-data": "",
    "out-truncated": 0,
  };
  const { api } = stubbedQemu(status);

  const result = await api.agentExecStatus("pve", 100, 4242);

  assert.deepEqual(result, status);
});
