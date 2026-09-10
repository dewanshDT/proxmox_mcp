import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProxmoxClient } from "../client/api.js";
import { ProxmoxApiError } from "../client/http.js";
import type { AgentExecStatus, GuestType, TaskStatus, Upid } from "../types/index.js";

const node = z.string().describe("Node name, e.g. 'pve'");
const vmid = z.number().int().positive().describe("Numeric VM/container ID, e.g. 100");
const guestType = z.enum(["qemu", "lxc"]).describe("'qemu' for VMs, 'lxc' for containers");

/**
 * Every snapshot-name parameter (`create`, `delete`, `rollback`) shares this
 * schema. Mirrors Proxmox's own `{snapname}` route format (`pve-configid`) and
 * closes the path-traversal hole in `delete`/`rollback`, which interpolate the
 * name straight into the URL path (see Proxmox MCP Safety §2, Invariants #6, D13).
 */
export const snapshotName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Must start with a letter; letters, digits, _ and - only");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  let message: string;
  if (error instanceof ProxmoxApiError) {
    message = error.message;
  } else if (error instanceof Error) {
    // undici wraps connection failures as "fetch failed" with the real error in .cause
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    message = `${error.name}: ${error.message}${cause}`;
  } else {
    message = String(error);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so Proxmox/network errors surface as tool errors instead of crashing the server. */
function safe<Args>(handler: (args: Args) => Promise<unknown>): (args: Args) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };
}

export interface RegisterOptions {
  /** The resolved `PROXMOX_WRITE_TOOLS` allowlist — a write tool registers iff its name is in here. */
  allow: ReadonlySet<string>;
}

/** Reversibility class of a write tool (see {@link WRITE_TOOL_GROUPS}). */
export type WriteGroup = "lifecycle" | "snapshot" | "destructive" | "exec";

/** One row of the {@link WRITE_TOOLS} table: a name, its group, and its self-registration. */
export interface WriteToolSpec {
  name: string;
  group: WriteGroup;
  register(server: McpServer, proxmox: ProxmoxClient): void;
}

export function registerTools(server: McpServer, proxmox: ProxmoxClient, options: RegisterOptions): void {
  // ---- Read-only tools ----

  server.registerTool(
    "proxmox_version",
    { description: "Get the Proxmox VE version" },
    safe(() => proxmox.version()),
  );

  server.registerTool(
    "proxmox_cluster_status",
    { description: "Get cluster status (works on standalone nodes too)" },
    safe(() => proxmox.cluster.status()),
  );

  server.registerTool(
    "proxmox_cluster_resources",
    {
      description:
        "Unified overview of all nodes, VMs, containers, and storage in one call. The best starting point for questions like 'what is running?'",
      inputSchema: {
        type: z.enum(["vm", "storage", "node", "sdn"]).optional().describe("Filter by resource type"),
      },
    },
    safe(({ type }) => proxmox.cluster.resources(type)),
  );

  server.registerTool(
    "proxmox_list_nodes",
    { description: "List all nodes with CPU/memory/disk usage" },
    safe(() => proxmox.nodes.list()),
  );

  server.registerTool(
    "proxmox_node_status",
    {
      description: "Detailed status of one node: CPU, memory, load average, kernel, uptime",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.nodes.status(node)),
  );

  server.registerTool(
    "proxmox_list_vms",
    {
      description: "List QEMU virtual machines on a node",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.qemu.list(node)),
  );

  server.registerTool(
    "proxmox_list_containers",
    {
      description: "List LXC containers on a node",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.lxc.list(node)),
  );

  server.registerTool(
    "proxmox_guest_status",
    {
      description: "Current status of a VM or container (state, CPU, memory, uptime)",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) =>
      type === "qemu" ? proxmox.qemu.status(node, vmid) : proxmox.lxc.status(node, vmid),
    ),
  );

  server.registerTool(
    "proxmox_guest_config",
    {
      description: "Configuration of a VM or container (cores, memory, disks, network)",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) =>
      type === "qemu" ? proxmox.qemu.config(node, vmid) : proxmox.lxc.config(node, vmid),
    ),
  );

  server.registerTool(
    "proxmox_list_snapshots",
    {
      description: "List snapshots of a VM or container",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) => proxmox.snapshots.list(node, type, vmid)),
  );

  server.registerTool(
    "proxmox_list_storage",
    {
      description: "List storage pools on a node with usage",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.storage.list(node)),
  );

  server.registerTool(
    "proxmox_storage_content",
    {
      description: "List contents of a storage pool (backups, ISOs, disk images)",
      inputSchema: {
        node,
        storage: z.string().describe("Storage ID, e.g. 'local'"),
        content: z.string().optional().describe("Filter by content type: backup, iso, images, vztmpl"),
      },
    },
    safe(({ node, storage, content }) => proxmox.storage.content(node, storage, content)),
  );

  server.registerTool(
    "proxmox_storage_status",
    {
      description: "Detailed status and usage of a single storage pool. Use proxmox_list_storage for all pools on a node.",
      inputSchema: { node, storage: z.string().describe("Storage ID, e.g. 'local-lvm'") },
    },
    safe(({ node, storage }) => proxmox.storage.status(node, storage)),
  );

  server.registerTool(
    "proxmox_node_network",
    {
      description: "List network interfaces and bridges configured on a node",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.nodes.network(node)),
  );

  server.registerTool(
    "proxmox_backup_jobs",
    {
      description:
        "List configured backup jobs (schedule, retention, selected guests). This is the backup " +
        "*schedule*; use proxmox_storage_content with content='backup' for the backup files themselves.",
    },
    safe(() => proxmox.cluster.backupJobs()),
  );

  server.registerTool(
    "proxmox_cluster_tasks",
    { description: "List recent tasks across the cluster" },
    safe(() => proxmox.cluster.tasks()),
  );

  server.registerTool(
    "proxmox_node_tasks",
    {
      description: "Recent task history for one node. Use proxmox_cluster_tasks for the cluster-wide view.",
      inputSchema: { node },
    },
    safe(({ node }) => proxmox.tasks.list(node)),
  );

  server.registerTool(
    "proxmox_task_status",
    {
      description: "Get the status of a task by UPID (returned by every write operation)",
      inputSchema: { node, upid: z.string().describe("Task UPID, e.g. 'UPID:pve:0004FABC:...'") },
    },
    safe(({ node, upid }) => proxmox.tasks.status(node, upid)),
  );

  server.registerTool(
    "proxmox_task_log",
    {
      description: "Get the log output of a task by UPID",
      inputSchema: { node, upid: z.string() },
    },
    safe(({ node, upid }) => proxmox.tasks.log(node, upid)),
  );

  // ---- Write tools ----
  //
  // Declarative: the registrar walks WRITE_TOOLS and registers an entry iff its
  // name is in the resolved PROXMOX_WRITE_TOOLS allowlist (`options.allow`, built
  // by resolveAllowlist — group aliases and `all` are already expanded to exact
  // names there). There is no code path by which a row registers when its name
  // is absent (see Proxmox MCP Invariants #1).
  for (const entry of WRITE_TOOLS) {
    if (options.allow.has(entry.name)) entry.register(server, proxmox);
  }
}

/**
 * Per-registration helpers shared by the write tools. `proxmox` is threaded in
 * by the registrar; both closures are unchanged from when they lived inline in
 * `registerTools`.
 */
function writeHelpers(proxmox: ProxmoxClient) {
  /**
   * Run a write op, then poll the resulting task, mapping {@link WaitResult}
   * to what the tool caller sees. A completed task (`done: true`) returns the
   * bare {@link TaskStatus} — the pre-timeout-result output shape, so the
   * caller still checks `exitstatus`. A task that outlasts the poll ceiling
   * (`done: false`) returns a plain "running" object naming the UPID to poll:
   * `safe()`/`ok()` wrap both without `isError` — a still-running task is not
   * a failure (see Proxmox MCP Task Model §timeout returns a result).
   */
  const runTask = async (
    nodeName: string,
    action: Promise<Upid>,
  ): Promise<TaskStatus | { status: "running"; upid: string; node: string; hint: string }> => {
    const upid = await action;
    const result = await proxmox.tasks.waitForTask(nodeName, upid);
    if (result.done) return result.status;
    return {
      status: "running",
      upid: result.upid,
      node: result.node,
      hint: "poll proxmox_task_status",
    };
  };

  const guestAction = (type: GuestType) => (type === "qemu" ? proxmox.qemu : proxmox.lxc);

  return { runTask, guestAction };
}

/**
 * Poll contract for `proxmox_guest_exec` — the same 1s / 120s shape as
 * `waitForTask`, but for a guest-agent PID rather than a UPID (see Proxmox MCP
 * Task Model §"Guest-agent exec is a different poll shape"). Mutable so tests
 * can force a fast timeout without fake timers.
 */
export const EXEC_POLL = { intervalMs: 1_000, ceilingMs: 120_000 };

/** Outcome of {@link pollExec}: the finished agent status, or "still running at the ceiling". */
type ExecPollResult =
  | { done: true; status: AgentExecStatus }
  | { done: false; pid: number; node: string; vmid: number };

/**
 * Poll `agentExecStatus` until `exited === 1`, mirroring `waitForTask`'s loop:
 * check, return on completion, bail with a non-error result once past the
 * ceiling, otherwise sleep and retry. Errors from `agentExecStatus` propagate.
 */
async function pollExec(
  proxmox: ProxmoxClient,
  node: string,
  vmid: number,
  pid: number,
): Promise<ExecPollResult> {
  const deadline = Date.now() + EXEC_POLL.ceilingMs;
  while (true) {
    const status = await proxmox.qemu.agentExecStatus(node, vmid, pid);
    if (status.exited === 1) return { done: true, status };
    if (Date.now() >= deadline) return { done: false, pid, node, vmid };
    await new Promise((resolve) => setTimeout(resolve, EXEC_POLL.intervalMs));
  }
}

/**
 * Shape an {@link AgentExecStatus} for a tool caller: `exited` as a real boolean
 * (`false` while the command is still running, `true` once finished),
 * `out-data`/`err-data` renamed to `stdout`/`stderr`, every other present field
 * passed through, `undefined` fields omitted. `proxmox_guest_exec` only reaches
 * this on the finished branch (`exited === 1`), so its output is unchanged;
 * `proxmox_guest_exec_status` can call it mid-run.
 */
function shapeExecResult(s: AgentExecStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { exited: s.exited === 1 };
  if (s.exitcode !== undefined) out.exitcode = s.exitcode;
  if (s.signal !== undefined) out.signal = s.signal;
  if (s["out-data"] !== undefined) out.stdout = s["out-data"];
  if (s["err-data"] !== undefined) out.stderr = s["err-data"];
  if (s["out-truncated"] !== undefined) out["out-truncated"] = s["out-truncated"];
  if (s["err-truncated"] !== undefined) out["err-truncated"] = s["err-truncated"];
  return out;
}

/**
 * The nine write tools, one row each. `registerTools` iterates this table and
 * calls `register` only for rows a predicate enables — there is no code path by
 * which a row here registers when its group is not allowed
 * (see Proxmox MCP Invariants #1). Groups follow the tool catalogue:
 * `proxmox_guest_stop` is `destructive` (a hard power-cut), not `lifecycle`.
 */
export const WRITE_TOOLS: readonly WriteToolSpec[] = [
  {
    name: "proxmox_guest_start",
    group: "lifecycle",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask, guestAction } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_guest_start",
        {
          description: "Start a VM or container. Waits for the task to finish and returns its result.",
          inputSchema: { node, type: guestType, vmid },
        },
        safe(({ node, type, vmid }) => runTask(node, guestAction(type).start(node, vmid))),
      );
    },
  },
  {
    name: "proxmox_guest_shutdown",
    group: "lifecycle",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask, guestAction } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_guest_shutdown",
        {
          description: "Gracefully shut down a VM (ACPI) or container. Prefer this over stop.",
          inputSchema: {
            node,
            type: guestType,
            vmid,
            timeout: z.number().int().positive().optional().describe("Seconds to wait before giving up"),
          },
        },
        safe(({ node, type, vmid, timeout }) =>
          runTask(node, guestAction(type).shutdown(node, vmid, timeout)),
        ),
      );
    },
  },
  {
    name: "proxmox_guest_reboot",
    group: "lifecycle",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask, guestAction } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_guest_reboot",
        {
          description: "Reboot a VM or container",
          inputSchema: { node, type: guestType, vmid },
        },
        safe(({ node, type, vmid }) => runTask(node, guestAction(type).reboot(node, vmid))),
      );
    },
  },
  {
    name: "proxmox_snapshot_create",
    group: "snapshot",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_snapshot_create",
        {
          description: "Create a snapshot of a VM or container",
          inputSchema: {
            node,
            type: guestType,
            vmid,
            name: snapshotName,
            description: z.string().optional(),
          },
        },
        safe(({ node, type, vmid, name, description }) =>
          runTask(node, proxmox.snapshots.create(node, type, vmid, name, description)),
        ),
      );
    },
  },
  {
    name: "proxmox_guest_stop",
    group: "destructive",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask, guestAction } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_guest_stop",
        {
          description: "Hard-stop a VM or container (like pulling the power cord). Use shutdown for a graceful stop.",
          inputSchema: { node, type: guestType, vmid },
        },
        safe(({ node, type, vmid }) => runTask(node, guestAction(type).stop(node, vmid))),
      );
    },
  },
  {
    name: "proxmox_snapshot_delete",
    group: "destructive",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_snapshot_delete",
        {
          description:
            "Delete a snapshot of a VM or container. DESTRUCTIVE: irreversible. " +
            "`expect_name` must equal `name` or the call is refused before any Proxmox request.",
          inputSchema: { node, type: guestType, vmid, name: snapshotName, expect_name: snapshotName },
        },
        safe(({ node, type, vmid, name, expect_name }) => {
          if (expect_name !== name) {
            throw new Error(
              `expect_name '${expect_name}' does not match target snapshot '${name}'; refusing`,
            );
          }
          return runTask(node, proxmox.snapshots.delete(node, type, vmid, name));
        }),
      );
    },
  },
  {
    name: "proxmox_snapshot_rollback",
    group: "destructive",
    register(server: McpServer, proxmox: ProxmoxClient) {
      const { runTask } = writeHelpers(proxmox);
      server.registerTool(
        "proxmox_snapshot_rollback",
        {
          description:
            "Roll a VM or container back to a snapshot. DESTRUCTIVE: current state is lost. " +
            "`expect_name` must equal `name` or the call is refused before any Proxmox request.",
          inputSchema: { node, type: guestType, vmid, name: snapshotName, expect_name: snapshotName },
        },
        safe(({ node, type, vmid, name, expect_name }) => {
          if (expect_name !== name) {
            throw new Error(
              `expect_name '${expect_name}' does not match target snapshot '${name}'; refusing`,
            );
          }
          return runTask(node, proxmox.snapshots.rollback(node, type, vmid, name));
        }),
      );
    },
  },
  {
    name: "proxmox_guest_exec",
    group: "exec",
    register(server: McpServer, proxmox: ProxmoxClient) {
      server.registerTool(
        "proxmox_guest_exec",
        {
          description:
            "Run a command inside a QEMU VM via the guest agent (argv array, no shell). " +
            "Polls for the result on a 1s / 120s contract; `wait:false` returns the pid " +
            "immediately, and hitting the ceiling returns a non-error 'running' result " +
            "naming the pid. QEMU only; requires the guest agent and VM.GuestAgent.Unrestricted.",
          inputSchema: {
            node,
            type: guestType.optional().default("qemu"),
            vmid,
            command: z
              .array(z.string())
              .min(1)
              .describe("Command as an argv array, e.g. ['systemctl','restart','nginx']. No shell."),
            input: z.string().max(65536).optional().describe("stdin passed to the command"),
            wait: z
              .boolean()
              .optional()
              .describe("Poll for the result (default true). false returns the pid immediately."),
          },
        },
        safe(async ({ node, type, vmid, command, input, wait }) => {
          // QEMU-only (D12): refuse an LXC target before any Proxmox call.
          if (type === "lxc") throw new Error("guest_exec supports QEMU VMs only");

          const { pid } = await proxmox.qemu.agentExec(node, vmid, command, input);
          if (wait === false) {
            return { pid, node, vmid, hint: "poll proxmox_guest_exec_status" };
          }

          const result = await pollExec(proxmox, node, vmid, pid);
          if (result.done) return shapeExecResult(result.status);
          return {
            status: "running",
            pid: result.pid,
            node: result.node,
            vmid: result.vmid,
            hint: "poll proxmox_guest_exec_status",
          };
        }),
      );
    },
  },
  {
    name: "proxmox_guest_exec_status",
    group: "exec",
    register(server: McpServer, proxmox: ProxmoxClient) {
      server.registerTool(
        "proxmox_guest_exec_status",
        {
          description:
            "Read the status and output of a command previously started by " +
            "proxmox_guest_exec, by its pid. Returns `exited` (false while still " +
            "running), `exitcode` / `signal`, and captured stdout/stderr. QEMU " +
            "guest-agent only; a bad pid or an unresponsive agent surfaces as a " +
            "Proxmox error.",
          inputSchema: {
            node,
            vmid,
            pid: z.number().int().positive().describe("The pid returned by proxmox_guest_exec"),
          },
        },
        safe(async ({ node, vmid, pid }) => {
          const status = await proxmox.qemu.agentExecStatus(node, vmid, pid);
          return shapeExecResult(status);
        }),
      );
    },
  },
];

/**
 * The group-alias table for `PROXMOX_WRITE_TOOLS` (see Proxmox MCP Write Access
 * §alias table). Each `WriteGroup` maps to the exact tool names it expands to.
 *
 * Every list here must stay in lockstep with the {@link WRITE_TOOLS} rows — a
 * drift-guard test asserts every row's `name` appears under its `group` here,
 * and that every name here has a matching row. Both `exec` tools
 * (`proxmox_guest_exec`, `proxmox_guest_exec_status`) now have rows.
 *
 * `proxmox_guest_stop` lives only under `destructive` (D11) — a hard power-cut,
 * never reachable via `lifecycle`.
 */
export const WRITE_TOOL_GROUPS: Record<WriteGroup, readonly string[]> = {
  lifecycle: ["proxmox_guest_start", "proxmox_guest_shutdown", "proxmox_guest_reboot"],
  snapshot: ["proxmox_snapshot_create"],
  destructive: ["proxmox_guest_stop", "proxmox_snapshot_delete", "proxmox_snapshot_rollback"],
  exec: ["proxmox_guest_exec", "proxmox_guest_exec_status"],
};

/** Every known write-tool name, across all groups (the union `all` expands to). */
const ALL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(WRITE_TOOL_GROUPS).flat());

/**
 * Expand a token list from `PROXMOX_WRITE_TOOLS` into the concrete set of write
 * tool names to register (see Proxmox MCP Write Access §Resolution rules).
 *
 * Each token is either:
 *   - `all` → every name across every group (union);
 *   - a group alias (`lifecycle` / `snapshot` / `destructive` / `exec`) → its
 *     {@link WRITE_TOOL_GROUPS} members;
 *   - an exact write-tool name → itself.
 *
 * An unrecognised token throws an `Error` naming it (D10); if several are
 * unknown the first one encountered is named. Empty input → empty set. This
 * resolver does not read env, `PROXMOX_READONLY`, or the deprecation bridge —
 * that precedence lives in `config.ts` (PMX-M1-03).
 */
export function resolveAllowlist(tokens: string[]): Set<string> {
  const resolved = new Set<string>();
  for (const token of tokens) {
    if (token === "all") {
      for (const name of ALL_WRITE_TOOL_NAMES) resolved.add(name);
    } else if (token in WRITE_TOOL_GROUPS) {
      for (const name of WRITE_TOOL_GROUPS[token as WriteGroup]) resolved.add(name);
    } else if (ALL_WRITE_TOOL_NAMES.has(token)) {
      resolved.add(token);
    } else {
      throw new Error(
        `Unknown PROXMOX_WRITE_TOOLS entry: "${token}" — expected a group alias ` +
          `(lifecycle, snapshot, destructive, exec, all) or an exact write-tool name`,
      );
    }
  }
  return resolved;
}

/** One-line summary of the resolved write allowlist for the startup bind log. */
export function writeToolSummary(allow: ReadonlySet<string>): string {
  return allow.size === 0 ? "[none]" : [...allow].sort().join(",");
}
