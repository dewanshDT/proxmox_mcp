import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/mcp/tools.js";
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
];

/** Collects registerTool() calls so we can inspect and invoke them. */
function collect(proxmox: Partial<ProxmoxClient>, readonly: boolean) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      assert.ok(!tools.has(name), `duplicate tool registration: ${name}`);
      tools.set(name, handler);
    },
  };
  registerTools(server as unknown as McpServer, proxmox as ProxmoxClient, { readonly });
  return tools;
}

// ---- readonly gating ----

test("read-only mode registers the 19 read tools and none of the write tools", () => {
  const tools = collect({}, true);

  assert.equal(tools.size, 19);
  for (const name of WRITE_TOOLS) {
    assert.ok(!tools.has(name), `${name} must not be reachable in read-only mode`);
  }
});

test("read-write mode registers all 26 tools", () => {
  const tools = collect({}, false);

  assert.equal(tools.size, 26);
  for (const name of WRITE_TOOLS) {
    assert.ok(tools.has(name), `${name} should be registered when writes are enabled`);
  }
});

test("the four formerly-unexposed client methods have tools", () => {
  const tools = collect({}, true);

  for (const name of [
    "proxmox_backup_jobs",
    "proxmox_node_network",
    "proxmox_storage_status",
    "proxmox_node_tasks",
  ]) {
    assert.ok(tools.has(name), `${name} should be registered`);
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
  const handler = collect(proxmox, true).get("proxmox_version");
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
