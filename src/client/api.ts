import { ProxmoxHttp, type ProxmoxConfig } from "./http.js";
import { AccessApi } from "../endpoints/access.js";
import { ClusterApi } from "../endpoints/cluster.js";
import { NodesApi } from "../endpoints/nodes.js";
import { QemuApi } from "../endpoints/qemu.js";
import { LxcApi } from "../endpoints/lxc.js";
import { SnapshotsApi } from "../endpoints/snapshots.js";
import { StorageApi } from "../endpoints/storage.js";
import { TasksApi } from "../endpoints/tasks.js";
import type { VersionInfo } from "../types/index.js";

/**
 * Typed Proxmox VE API client. Knows nothing about MCP — reusable for a CLI,
 * dashboard, or any other automation.
 */
export class ProxmoxClient {
  readonly access: AccessApi;
  readonly cluster: ClusterApi;
  readonly nodes: NodesApi;
  readonly qemu: QemuApi;
  readonly lxc: LxcApi;
  readonly snapshots: SnapshotsApi;
  readonly storage: StorageApi;
  readonly tasks: TasksApi;

  private readonly http: ProxmoxHttp;

  constructor(config: ProxmoxConfig) {
    this.http = new ProxmoxHttp(config);
    this.access = new AccessApi(this.http);
    this.cluster = new ClusterApi(this.http);
    this.nodes = new NodesApi(this.http);
    this.qemu = new QemuApi(this.http);
    this.lxc = new LxcApi(this.http);
    this.snapshots = new SnapshotsApi(this.http);
    this.storage = new StorageApi(this.http);
    this.tasks = new TasksApi(this.http);
  }

  version(): Promise<VersionInfo> {
    return this.http.get("/version");
  }
}

export { ProxmoxApiError, type ProxmoxConfig } from "./http.js";
