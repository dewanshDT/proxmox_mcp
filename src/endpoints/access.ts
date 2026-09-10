import type { ProxmoxHttp } from "../client/http.js";
import type { EffectivePermissions } from "../types/index.js";

export class AccessApi {
  constructor(private readonly http: ProxmoxHttp) {}

  /** Effective, role-expanded permissions of the configured token (or `userid`),
   *  optionally scoped to one ACL path. Key: ACL path; inner key: privilege;
   *  value: propagation flag (1 = also applies to child paths). Roles are already
   *  collapsed to privileges by Proxmox. */
  permissions(path?: string): Promise<EffectivePermissions> {
    return this.http.get("/access/permissions", { path });
  }
}
