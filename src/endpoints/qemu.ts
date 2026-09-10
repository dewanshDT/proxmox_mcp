import type { ProxmoxHttp } from "../client/http.js";
import type {
  AgentExecStart,
  AgentExecStatus,
  GuestListEntry,
  GuestStatus,
  Upid,
} from "../types/index.js";

export class QemuApi {
  constructor(private readonly http: ProxmoxHttp) {}

  list(node: string): Promise<GuestListEntry[]> {
    return this.http.get(`/nodes/${node}/qemu`);
  }

  status(node: string, vmid: number): Promise<GuestStatus> {
    return this.http.get(`/nodes/${node}/qemu/${vmid}/status/current`);
  }

  config(node: string, vmid: number): Promise<Record<string, unknown>> {
    return this.http.get(`/nodes/${node}/qemu/${vmid}/config`);
  }

  start(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/qemu/${vmid}/status/start`);
  }

  /** Hard stop — like pulling the power cord */
  stop(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/qemu/${vmid}/status/stop`);
  }

  /** Graceful ACPI shutdown */
  shutdown(node: string, vmid: number, timeoutSeconds?: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/qemu/${vmid}/status/shutdown`, {
      timeout: timeoutSeconds,
    });
  }

  reboot(node: string, vmid: number): Promise<Upid> {
    return this.http.post(`/nodes/${node}/qemu/${vmid}/status/reboot`);
  }

  /** Run a command inside a QEMU VM via the guest agent. Returns immediately with
   *  a PID; poll agentExecStatus for the result. Requires the guest agent and
   *  VM.GuestAgent.Unrestricted. */
  agentExec(node: string, vmid: number, command: string[], input?: string): Promise<AgentExecStart> {
    return this.http.post(`/nodes/${node}/qemu/${vmid}/agent/exec`, {
      command,
      "input-data": input,
    });
  }

  /** Status/output of a command started by agentExec, by its PID. */
  agentExecStatus(node: string, vmid: number, pid: number): Promise<AgentExecStatus> {
    return this.http.get(`/nodes/${node}/qemu/${vmid}/agent/exec-status`, { pid });
  }
}
