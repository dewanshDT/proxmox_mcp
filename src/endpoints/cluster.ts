import type { ProxmoxHttp } from "../client/http.js";
import type { ClusterResource, TaskListEntry } from "../types/index.js";

export class ClusterApi {
  constructor(private readonly http: ProxmoxHttp) {}

  /** Cluster (or standalone node) status */
  status(): Promise<unknown[]> {
    return this.http.get("/cluster/status");
  }

  /**
   * Unified view of all nodes, VMs, LXCs, and storage in one call.
   * Works on standalone installations too.
   */
  resources(type?: "vm" | "storage" | "node" | "sdn"): Promise<ClusterResource[]> {
    return this.http.get("/cluster/resources", { type });
  }

  /** Recent cluster-wide task list */
  tasks(): Promise<TaskListEntry[]> {
    return this.http.get("/cluster/tasks");
  }

  /** Configured backup jobs */
  backupJobs(): Promise<unknown[]> {
    return this.http.get("/cluster/backup");
  }
}
