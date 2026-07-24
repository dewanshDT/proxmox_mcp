import type { ProxmoxHttp } from "../client/http.js";
import type { StorageEntry } from "../types/index.js";

export class StorageApi {
  constructor(private readonly http: ProxmoxHttp) {}

  /** Storage pools visible on a node, with usage */
  list(node: string): Promise<StorageEntry[]> {
    return this.http.get(`/nodes/${node}/storage`);
  }

  /** Contents of a storage pool (ISOs, backups, disk images, ...) */
  content(node: string, storage: string, contentType?: string): Promise<unknown[]> {
    return this.http.get(`/nodes/${node}/storage/${storage}/content`, {
      content: contentType,
    });
  }

  status(node: string, storage: string): Promise<StorageEntry> {
    return this.http.get(`/nodes/${node}/storage/${storage}/status`);
  }
}
