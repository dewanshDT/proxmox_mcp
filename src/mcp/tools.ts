import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProxmoxClient } from "../client/api.js";
import { ProxmoxApiError } from "../client/http.js";
import type { GuestType, TaskStatus, Upid } from "../types/index.js";

const node = z.string().describe("Node name, e.g. 'pve'");
const vmid = z.number().int().positive().describe("Numeric VM/container ID, e.g. 100");
const guestType = z.enum(["qemu", "lxc"]).describe("'qemu' for VMs, 'lxc' for containers");

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
  /** When true, only read-only tools are registered. */
  readonly: boolean;
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
    "proxmox_cluster_tasks",
    { description: "List recent tasks across the cluster" },
    safe(() => proxmox.cluster.tasks()),
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

  if (options.readonly) return;

  // ---- Write tools ----

  /** Run a write op, then poll the resulting task to completion. */
  const runTask = async (nodeName: string, action: Promise<Upid>): Promise<TaskStatus> => {
    const upid = await action;
    return proxmox.tasks.waitForTask(nodeName, upid);
  };

  const guestAction = (type: GuestType) => (type === "qemu" ? proxmox.qemu : proxmox.lxc);

  server.registerTool(
    "proxmox_guest_start",
    {
      description: "Start a VM or container. Waits for the task to finish and returns its result.",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) => runTask(node, guestAction(type).start(node, vmid))),
  );

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

  server.registerTool(
    "proxmox_guest_stop",
    {
      description: "Hard-stop a VM or container (like pulling the power cord). Use shutdown for a graceful stop.",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) => runTask(node, guestAction(type).stop(node, vmid))),
  );

  server.registerTool(
    "proxmox_guest_reboot",
    {
      description: "Reboot a VM or container",
      inputSchema: { node, type: guestType, vmid },
    },
    safe(({ node, type, vmid }) => runTask(node, guestAction(type).reboot(node, vmid))),
  );

  server.registerTool(
    "proxmox_snapshot_create",
    {
      description: "Create a snapshot of a VM or container",
      inputSchema: {
        node,
        type: guestType,
        vmid,
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Must start with a letter; letters, digits, _ and - only"),
        description: z.string().optional(),
      },
    },
    safe(({ node, type, vmid, name, description }) =>
      runTask(node, proxmox.snapshots.create(node, type, vmid, name, description)),
    ),
  );

  server.registerTool(
    "proxmox_snapshot_delete",
    {
      description: "Delete a snapshot of a VM or container",
      inputSchema: { node, type: guestType, vmid, name: z.string() },
    },
    safe(({ node, type, vmid, name }) =>
      runTask(node, proxmox.snapshots.delete(node, type, vmid, name)),
    ),
  );

  server.registerTool(
    "proxmox_snapshot_rollback",
    {
      description:
        "Roll a VM or container back to a snapshot. DESTRUCTIVE: current state is lost.",
      inputSchema: { node, type: guestType, vmid, name: z.string() },
    },
    safe(({ node, type, vmid, name }) =>
      runTask(node, proxmox.snapshots.rollback(node, type, vmid, name)),
    ),
  );
}
