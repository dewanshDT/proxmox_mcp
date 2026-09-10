import type { ProxmoxHttp } from "../client/http.js";
import type { TaskListEntry, TaskStatus } from "../types/index.js";

export interface WaitOptions {
  /** Give up after this long. Default: 120s */
  timeoutMs?: number;
  /** Poll interval. Default: 1s */
  pollIntervalMs?: number;
}

/**
 * Outcome of {@link TasksApi.waitForTask}. Either the task reached
 * `status: "stopped"` before the ceiling — inspect `status.exitstatus` —
 * or it was still running when we gave up, in which case the caller keeps
 * polling `proxmox_task_status` with the returned UPID. Timing out is a
 * result, not an error.
 */
export type WaitResult =
  | { done: true; status: TaskStatus }
  | { done: false; upid: string; node: string };

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
   * Resolves `{ done: true, status }` once the task stops — the caller should
   * check `status.exitstatus` ("OK" on success). If the task is still running
   * when the timeout is hit, resolves `{ done: false, upid, node }` rather
   * than throwing: the Proxmox task is still alive and can be polled via
   * `status()`. Errors from `status()` (network/HTTP) still propagate.
   */
  async waitForTask(node: string, upid: string, options?: WaitOptions): Promise<WaitResult> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.status(node, upid);
      if (status.status === "stopped") return { done: true, status };
      if (Date.now() >= deadline) return { done: false, upid, node };
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
