import type { ProxmoxHttp } from "../client/http.js";
import type { GuestType, Snapshot, Upid } from "../types/index.js";

/** Snapshot operations — identical paths for QEMU VMs and LXC containers. */
export class SnapshotsApi {
  constructor(private readonly http: ProxmoxHttp) {}

  list(node: string, type: GuestType, vmid: number): Promise<Snapshot[]> {
    return this.http.get(`/nodes/${node}/${type}/${vmid}/snapshot`);
  }

  create(
    node: string,
    type: GuestType,
    vmid: number,
    name: string,
    description?: string,
  ): Promise<Upid> {
    return this.http.post(`/nodes/${node}/${type}/${vmid}/snapshot`, {
      snapname: name,
      description,
    });
  }

  delete(node: string, type: GuestType, vmid: number, name: string): Promise<Upid> {
    return this.http.delete(`/nodes/${node}/${type}/${vmid}/snapshot/${name}`);
  }

  rollback(node: string, type: GuestType, vmid: number, name: string): Promise<Upid> {
    return this.http.post(`/nodes/${node}/${type}/${vmid}/snapshot/${name}/rollback`);
  }
}
