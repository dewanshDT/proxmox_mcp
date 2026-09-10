import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EXEC_POLL,
  registerTools,
  resolveAllowlist,
  WRITE_TOOLS as WRITE_TOOL_SPECS,
} from "../src/mcp/tools.js";
import { ProxmoxApiError } from "../src/client/http.js";
import type { ProxmoxClient } from "../src/client/api.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const WRITE_TOOLS = [
  "proxmox_guest_start",
  "proxmox_guest_shutdown",
  "proxmox_guest_stop",
  "proxmox_guest_reboot",
  "proxmox_snapshot_create",
  "proxmox_snapshot_delete",
  "proxmox_snapshot_rollback",
  "proxmox_guest_exec",
  "proxmox_guest_exec_status",
];

/** Collects registerTool() calls so we can inspect and invoke them. */
function collect(proxmox: Partial<ProxmoxClient>, allow: ReadonlySet<string>) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      assert.ok(!tools.has(name), `duplicate tool registration: ${name}`);
      tools.set(name, handler);
    },
  };
  registerTools(server as unknown as McpServer, proxmox as ProxmoxClient, { allow });
  return tools;
}

// ---- readonly gating ----

test("read-only mode registers the 19 read tools and none of the write tools", () => {
  const tools = collect({}, new Set());

  assert.equal(tools.size, 19);
  for (const name of WRITE_TOOLS) {
    assert.ok(!tools.has(name), `${name} must not be reachable in read-only mode`);
  }
});

test("read-write mode registers all 28 tools", () => {
  const tools = collect({}, resolveAllowlist(["all"]));

  assert.equal(tools.size, 28);
  for (const name of WRITE_TOOLS) {
    assert.ok(tools.has(name), `${name} should be registered when writes are enabled`);
  }
});

// ---- PMX-M1-04: the resolved allowlist gates write-tool registration ----

test("lifecycle allowlist registers the 19 read tools plus start/shutdown/reboot only", () => {
  const tools = collect({}, resolveAllowlist(["lifecycle"]));

  assert.equal(tools.size, 22);
  assert.deepEqual(
    new Set(tools.keys()),
    new Set([
      ...READ_TOOLS,
      "proxmox_guest_start",
      "proxmox_guest_shutdown",
      "proxmox_guest_reboot",
    ]),
  );
  assert.ok(!tools.has("proxmox_guest_stop"), "guest_stop is destructive, never via lifecycle (D11)");
});

test("the 'all' allowlist registers all 28 tools including every write name", () => {
  const tools = collect({}, resolveAllowlist(["all"]));

  assert.equal(tools.size, 28);
  for (const name of WRITE_TOOLS) {
    assert.ok(tools.has(name), `${name} should be registered under 'all'`);
  }
});

test("the four formerly-unexposed client methods have tools", () => {
  const tools = collect({}, new Set());

  for (const name of [
    "proxmox_backup_jobs",
    "proxmox_node_network",
    "proxmox_storage_status",
    "proxmox_node_tasks",
  ]) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }
});

// ---- invariant #1: the declarative WRITE_TOOLS table ----

const READ_TOOLS = [
  "proxmox_version",
  "proxmox_cluster_status",
  "proxmox_cluster_resources",
  "proxmox_list_nodes",
  "proxmox_node_status",
  "proxmox_list_vms",
  "proxmox_list_containers",
  "proxmox_guest_status",
  "proxmox_guest_config",
  "proxmox_list_snapshots",
  "proxmox_list_storage",
  "proxmox_storage_content",
  "proxmox_storage_status",
  "proxmox_node_network",
  "proxmox_backup_jobs",
  "proxmox_cluster_tasks",
  "proxmox_node_tasks",
  "proxmox_task_status",
  "proxmox_task_log",
];

test("every WRITE_TOOLS entry declares one of the four valid groups", () => {
  const validGroups = new Set(["lifecycle", "snapshot", "destructive", "exec"]);

  assert.equal(WRITE_TOOL_SPECS.length, 9);
  assert.deepEqual(
    new Set(WRITE_TOOL_SPECS.map((entry) => entry.name)),
    new Set(WRITE_TOOLS),
  );
  for (const entry of WRITE_TOOL_SPECS) {
    assert.ok(validGroups.has(entry.group), `${entry.name} has invalid group ${entry.group}`);
    assert.equal(typeof entry.register, "function");
  }
});

test("the disabled predicate registers exactly the 19 read tools and zero write tools", () => {
  const tools = collect({}, new Set()); // empty allowlist -> no write tool's name matches

  assert.deepEqual([...tools.keys()].sort(), [...READ_TOOLS].sort());
  for (const entry of WRITE_TOOL_SPECS) {
    assert.ok(!tools.has(entry.name), `${entry.name} must not register when the predicate is disabled`);
  }
});

// ---- safe() error mapping ----

/** Build a client whose version() rejects with the given value. */
function throwingClient(error: unknown): Partial<ProxmoxClient> {
  return {
    version: () => Promise.reject(error),
  } as Partial<ProxmoxClient>;
}

async function callVersion(proxmox: Partial<ProxmoxClient>) {
  const handler = collect(proxmox, new Set()).get("proxmox_version");
  assert.ok(handler, "proxmox_version should be registered");
  return handler({});
}

test("a successful call returns pretty-printed JSON and no error flag", async () => {
  const proxmox = { version: () => Promise.resolve({ version: "9.1.1" }) };

  const result = await callVersion(proxmox as unknown as Partial<ProxmoxClient>);

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, JSON.stringify({ version: "9.1.1" }, null, 2));
});

test("a ProxmoxApiError surfaces as a tool error with its message intact", async () => {
  const error = new ProxmoxApiError(
    "GET /version failed: 403 Forbidden — Permission check failed",
    403,
    "GET",
    "/version",
  );

  const result = await callVersion(throwingClient(error));

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, error.message);
});

test("undici's opaque 'fetch failed' is unwrapped to show the real cause", async () => {
  const error = new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.1:8006") });

  const result = await callVersion(throwingClient(error));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fetch failed \(connect ECONNREFUSED 10\.0\.0\.1:8006\)/);
});

test("an error with no cause still reports its name and message", async () => {
  const result = await callVersion(throwingClient(new TypeError("bad input")));

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "TypeError: bad input");
});

test("a non-Error throw is stringified rather than crashing the transport", async () => {
  const result = await callVersion(throwingClient("something odd"));

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "something odd");
});

// ---- PMX-M0-03: runTask maps the WaitResult so a still-running task is not an error ----

const RUNNING_UPID = "UPID:pve:0004FABC:00272B98:66A1B2C3:qmstart:100:root@pam:";

/** Invoke the proxmox_guest_start handler against a stubbed client. */
function guestStart(proxmox: Partial<ProxmoxClient>) {
  const handler = collect(proxmox, resolveAllowlist(["all"])).get("proxmox_guest_start");
  assert.ok(handler, "proxmox_guest_start should be registered in read-write mode");
  return handler;
}

test("a write tool whose task never stops returns a non-error 'running' result naming the UPID", async () => {
  const proxmox = {
    qemu: { start: () => Promise.resolve(RUNNING_UPID) },
    tasks: {
      waitForTask: () => Promise.resolve({ done: false, upid: RUNNING_UPID, node: "pve" }),
    },
  } as unknown as Partial<ProxmoxClient>;

  const result = await guestStart(proxmox)({ node: "pve", type: "qemu", vmid: 100 });

  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes(RUNNING_UPID), "text should name the UPID to poll");
  assert.match(result.content[0].text, /running/);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    status: "running",
    upid: RUNNING_UPID,
    node: "pve",
    hint: "poll proxmox_task_status",
  });
});

test("a write tool whose task stops returns the bare TaskStatus, no done/hint wrapper", async () => {
  const status = {
    upid: RUNNING_UPID,
    node: "pve",
    type: "qmstart",
    status: "stopped",
    exitstatus: "OK",
  };
  const proxmox = {
    qemu: { start: () => Promise.resolve(RUNNING_UPID) },
    tasks: {
      waitForTask: () => Promise.resolve({ done: true, status }),
    },
  } as unknown as Partial<ProxmoxClient>;

  const result = await guestStart(proxmox)({ node: "pve", type: "qemu", vmid: 100 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), status);
  assert.ok(!result.content[0].text.includes('"done"'), "no discriminator leaks through");
  assert.ok(!result.content[0].text.includes('"hint"'), "no running-shape hint on a stopped task");
});

// ---- PMX-M3-01: expect_name guardrail on snapshot_delete + snapshot_rollback ----

/**
 * A ProxmoxClient stub whose `snapshots` records which destructive method was
 * invoked, so a test can assert invariant #5 (zero SDK calls on refusal).
 */
function recordingSnapshotClient() {
  const calls: string[] = [];
  const proxmox = {
    snapshots: {
      delete: (..._a: unknown[]) => {
        calls.push("delete");
        return Promise.resolve(RUNNING_UPID);
      },
      rollback: (..._a: unknown[]) => {
        calls.push("rollback");
        return Promise.resolve(RUNNING_UPID);
      },
    },
    tasks: {
      waitForTask: () =>
        Promise.resolve({ done: true, status: { exitstatus: "OK" } }),
    },
  } as unknown as Partial<ProxmoxClient>;
  return { calls, proxmox };
}

for (const { tool, method } of [
  { tool: "proxmox_snapshot_delete", method: "delete" },
  { tool: "proxmox_snapshot_rollback", method: "rollback" },
] as const) {
  test(`PMX-M3-01: ${tool} refuses and makes zero SDK calls when expect_name !== name`, async () => {
    const { calls, proxmox } = recordingSnapshotClient();
    const handler = collect(proxmox, resolveAllowlist(["destructive"])).get(tool);
    assert.ok(handler, `${tool} should be registered under the destructive allowlist`);

    const result = await handler({
      node: "pve",
      type: "qemu",
      vmid: 100,
      name: "target",
      expect_name: "wrong",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("wrong"), "text names the supplied expect_name");
    assert.ok(result.content[0].text.includes("target"), "text names the target snapshot");
    assert.match(result.content[0].text, /refusing/);
    assert.deepEqual(calls, [], "invariant #5: no Proxmox call on a mismatch");
  });

  test(`PMX-M3-01: ${tool} passes through unchanged when expect_name === name`, async () => {
    const { calls, proxmox } = recordingSnapshotClient();
    const handler = collect(proxmox, resolveAllowlist(["all"])).get(tool);
    assert.ok(handler, `${tool} should be registered under 'all'`);

    const result = await handler({
      node: "pve",
      type: "qemu",
      vmid: 100,
      name: "target",
      expect_name: "target",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [method], `the one ${method} call is recorded on a match`);
    assert.deepEqual(JSON.parse(result.content[0].text), { exitstatus: "OK" });
  });
}

// ---- PMX-M4-02: proxmox_guest_exec — poll loop + wait flag + QEMU-only refusal ----

/**
 * A ProxmoxClient stub whose `qemu.agentExec` / `qemu.agentExecStatus` are
 * controlled by the caller and record whether they were invoked.
 */
function execClient(opts: {
  agentExec?: (...a: unknown[]) => Promise<unknown>;
  agentExecStatus?: (...a: unknown[]) => Promise<unknown>;
}) {
  const calls: string[] = [];
  const proxmox = {
    qemu: {
      agentExec: (...a: unknown[]) => {
        calls.push("exec");
        return (opts.agentExec ?? (() => Promise.resolve({ pid: 42 })))(...a);
      },
      agentExecStatus: (...a: unknown[]) => {
        calls.push("status");
        return (opts.agentExecStatus ?? (() => Promise.resolve({ exited: 1 })))(...a);
      },
    },
  } as unknown as Partial<ProxmoxClient>;
  return { calls, proxmox };
}

function execHandler(proxmox: Partial<ProxmoxClient>) {
  const handler = collect(proxmox, resolveAllowlist(["exec"])).get("proxmox_guest_exec");
  assert.ok(handler, "proxmox_guest_exec should be registered under the exec allowlist");
  return handler;
}

test("PMX-M4-02: happy path — POSTs the command then returns the finished result", async () => {
  const { calls, proxmox } = execClient({
    agentExec: () => Promise.resolve({ pid: 42 }),
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, "out-data": "hi\n" }),
  });

  const result = await execHandler(proxmox)({ node: "pve", vmid: 100, command: ["echo", "hi"] });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    exited: true,
    exitcode: 0,
    stdout: "hi\n",
  });
  assert.deepEqual(calls, ["exec", "status"]);
});

test("PMX-M4-02: wait:false returns { pid, node, vmid } immediately and never polls status", async () => {
  const { calls, proxmox } = execClient({ agentExec: () => Promise.resolve({ pid: 42 }) });

  const result = await execHandler(proxmox)({
    node: "pve",
    vmid: 100,
    command: ["sleep", "5"],
    wait: false,
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.pid, 42);
  assert.equal(payload.node, "pve");
  assert.equal(payload.vmid, 100);
  assert.match(payload.hint, /poll/);
  assert.deepEqual(calls, ["exec"], "agentExecStatus must not be called when wait is false");
});

test("PMX-M4-02: hitting the poll ceiling returns a non-error 'running' result naming the pid", async () => {
  const saved = { ...EXEC_POLL };
  EXEC_POLL.ceilingMs = 0;
  EXEC_POLL.intervalMs = 0;
  try {
    const { proxmox } = execClient({
      agentExec: () => Promise.resolve({ pid: 42 }),
      agentExecStatus: () => Promise.resolve({ exited: 0 }),
    });

    const result = await execHandler(proxmox)({ node: "pve", vmid: 100, command: ["sleep", "99"] });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /42/);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      status: "running",
      pid: 42,
      node: "pve",
      vmid: 100,
      hint: "poll proxmox_guest_exec_status",
    });
  } finally {
    Object.assign(EXEC_POLL, saved);
  }
});

test("PMX-M4-02: an LXC target is refused before any Proxmox call", async () => {
  const { calls, proxmox } = execClient({});

  const result = await execHandler(proxmox)({
    node: "pve",
    type: "lxc",
    vmid: 100,
    command: ["ls"],
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /QEMU VMs only/);
  assert.deepEqual(calls, [], "neither agentExec nor agentExecStatus is called for an LXC target");
});

test("PMX-M4-02: an agent-down Proxmox error surfaces intact", async () => {
  const error = new ProxmoxApiError(
    "QEMU guest agent is not running",
    500,
    "POST",
    "/nodes/pve/qemu/100/agent/exec",
  );
  const { proxmox } = execClient({ agentExec: () => Promise.reject(error) });

  const result = await execHandler(proxmox)({ node: "pve", vmid: 100, command: ["true"] });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /QEMU guest agent is not running/);
});

// ---- PMX-M4-03: proxmox_guest_exec_status — one-shot status read, no poll loop ----

function execStatusHandler(proxmox: Partial<ProxmoxClient>) {
  const handler = collect(proxmox, resolveAllowlist(["exec"])).get("proxmox_guest_exec_status");
  assert.ok(handler, "proxmox_guest_exec_status should be registered under the exec allowlist");
  return handler;
}

test("PMX-M4-03: a finished command reports exited:true with decoded stdout/stderr", async () => {
  const proxmox = {
    qemu: {
      agentExecStatus: () =>
        Promise.resolve({ exited: 1, exitcode: 0, "out-data": "ok\n", "err-data": "" }),
    },
  } as unknown as Partial<ProxmoxClient>;

  const result = await execStatusHandler(proxmox)({ node: "pve", vmid: 100, pid: 42 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    exited: true,
    exitcode: 0,
    stdout: "ok\n",
    stderr: "",
  });
});

test("PMX-M4-03: a still-running command reports exited:false and omits exitcode/stdout", async () => {
  const proxmox = {
    qemu: { agentExecStatus: () => Promise.resolve({ exited: 0 }) },
  } as unknown as Partial<ProxmoxClient>;

  const result = await execStatusHandler(proxmox)({ node: "pve", vmid: 100, pid: 42 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { exited: false });
});
