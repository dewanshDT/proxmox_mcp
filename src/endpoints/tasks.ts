import type { ProxmoxHttp } from "../client/http.js";
import type { TaskListEntry, TaskStatus } from "../types/index.js";

export interface WaitOptions {
  /** Give up after this long. Default: 120s */
  timeoutMs?: number;
  /** Poll interval. Default: 1s */
  pollIntervalMs?: number;
}

export class TasksApi {
  constructor(private readonly http: ProxmoxHttp) {}

  list(node: string): Promise<TaskListEntry[]> {
    return this.http.get(`/nodes/${node}/tasks`);
  }

  status(node: string, upid: string): Promise<TaskStatus> {
    return this.http.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
  }

  log(node: string, upid: string): Promise<Array<{ n: number; t: string }>> {
    return this.http.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`);
  }

  /**
   * Poll a task until it finishes. Every Proxmox write operation returns a
   * UPID; use this to make those operations effectively synchronous.
   * Resolves with the final status; the caller should check `exitstatus`
   * ("OK" on success).
   */
  async waitForTask(node: string, upid: string, options?: WaitOptions): Promise<TaskStatus> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.status(node, upid);
      if (status.status === "stopped") return status;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for task ${upid}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
