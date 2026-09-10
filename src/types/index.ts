/** Version info from GET /version */
export interface VersionInfo {
  version: string;
  release: string;
  repoid: string;
}

/** Entry from GET /nodes */
export interface NodeListEntry {
  node: string;
  status: "online" | "offline" | "unknown";
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
}

/** Entry from GET /cluster/resources — unified view of nodes, VMs, LXCs, storage */
export interface ClusterResource {
  id: string;
  type: "node" | "qemu" | "lxc" | "storage" | "sdn" | "pool" | "openvz";
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  storage?: string;
  template?: number;
  tags?: string;
}

/** Entry from GET /nodes/{node}/qemu or /nodes/{node}/lxc */
export interface GuestListEntry {
  vmid: number;
  name?: string;
  status: "running" | "stopped" | "paused";
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
}

/** GET .../status/current for a VM or container */
export interface GuestStatus {
  vmid: number;
  name?: string;
  status: string;
  qmpstatus?: string;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  ha?: unknown;
}

/** Entry from GET .../snapshot */
export interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: number;
}

/** Entry from GET /nodes/{node}/storage */
export interface StorageEntry {
  storage: string;
  type: string;
  content: string;
  active?: number;
  enabled?: number;
  used?: number;
  avail?: number;
  total?: number;
  shared?: number;
}

/** GET /nodes/{node}/tasks/{upid}/status */
export interface TaskStatus {
  upid: string;
  node: string;
  type: string;
  status: "running" | "stopped";
  exitstatus?: string;
  starttime?: number;
  user?: string;
  id?: string;
  pid?: number;
}

/** Entry from GET /cluster/tasks or /nodes/{node}/tasks */
export interface TaskListEntry {
  upid: string;
  node: string;
  type: string;
  status?: string;
  starttime?: number;
  endtime?: number;
  user?: string;
  id?: string;
}

/** POST /nodes/{node}/qemu/{vmid}/agent/exec */
export interface AgentExecStart {
  pid: number;
}

/** GET /nodes/{node}/qemu/{vmid}/agent/exec-status — booleans arrive as 1/0.
 *  While the command runs only `exited: 0` is present; `out-data` / `err-data`
 *  are already base64-decoded to plain text by Proxmox. */
export interface AgentExecStatus {
  exited: 0 | 1;
  exitcode?: number;
  signal?: number;
  "out-data"?: string;
  "err-data"?: string;
  "out-truncated"?: 0 | 1;
  "err-truncated"?: 0 | 1;
}

/** GET /access/permissions — path -> (privilege -> propagation flag). */
export type EffectivePermissions = Record<string, Record<string, 0 | 1>>;

/** A UPID string, e.g. "UPID:pve:0004FABC:..." — returned by every write operation */
export type Upid = string;

export type GuestType = "qemu" | "lxc";
