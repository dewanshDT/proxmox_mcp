import type { ProxmoxHttp } from "../client/http.js";
import type { GuestListEntry, GuestStatus, Upid } from "../types/index.js";

export class LxcApi {
  constructor(private readonly http: ProxmoxHttp) {}

  list(node: string): Promise<GuestListEntry[]> {
    return this.http.get(`/nodes/${node}/lxc`);
  }

  status(node: string, vmid: number): Promise<GuestStatus> {
    return this.http.get(`/nodes/${node}/lxc/${vmid}/status/current`);
  }

  config(node: string, vmid: number): Promise<Record<string, unknown>> {
    return this.http.get(`/nodes/${node}/lxc/${vmid}/config`);
  }

  start(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/lxc/${vmid}/status/start`);
  }

  stop(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/lxc/${vmid}/status/stop`);
  }

  shutdown(node: string, vmid: number, timeoutSeconds?: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/lxc/${vmid}/status/shutdown`, {
      timeout: timeoutSeconds,
    });
  }

  reboot(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/lxc/${vmid}/status/reboot`);
  }
}
