import type { ProxmoxHttp } from "../client/http.js";
import type { NodeListEntry } from "../types/index.js";

export class NodesApi {
  constructor(private readonly http: ProxmoxHttp) {}

  list(): Promise<NodeListEntry[]> {
    return this.http.get("/nodes");
  }

  /** Detailed node status: CPU, memory, load, kernel version, uptime */
  status(node: string): Promise<unknown> {
    return this.http.get(`/nodes/${node}/status`);
  }

  network(node: string): Promise<unknown[]> {
    return this.http.get(`/nodes/${node}/network`);
  }
}
