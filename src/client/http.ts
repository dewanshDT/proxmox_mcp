import { Agent, fetch } from "undici";

export interface ProxmoxConfig {
  /** Base URL, e.g. "https://192.168.1.10:8006" */
  host: string;
  /** Full token id, e.g. "mcp@pve!homelab" */
  tokenId: string;
  /** Token secret (UUID) */
  tokenSecret: string;
  /** Accept self-signed certificates (common on homelab Proxmox). Default: false */
  allowSelfSigned?: boolean;
  /** Request timeout in ms. Default: 30000 */
  timeoutMs?: number;
}

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly errors?: unknown,
  ) {
    super(message);
    this.name = "ProxmoxApiError";
  }
}

type ParamValue = string | number | boolean | undefined;
type Params = Record<string, ParamValue | string[] | number[]>;

/**
 * Minimal HTTP client for the Proxmox VE API. Knows about the base path,
 * token auth, and the { data: ... } response envelope — nothing else.
 */
export class ProxmoxHttp {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly dispatcher?: Agent;
  private readonly timeoutMs: number;

  constructor(config: ProxmoxConfig) {
    this.baseUrl = config.host.replace(/\/+$/, "") + "/api2/json";
    this.authHeader = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (config.allowSelfSigned) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  get<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  post<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>("POST", path, params);
  }

  put<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>("PUT", path, params);
  }

  delete<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }

  private async request<T>(method: string, path: string, params?: Params): Promise<T> {
    let url = this.baseUrl + path;
    const headers: Record<string, string> = { Authorization: this.authHeader };
    let body: string | undefined;

    const encoded = encodeParams(params);
    if (encoded) {
      if (method === "GET" || method === "DELETE") {
        url += "?" + encoded;
      } else {
        body = encoded;
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    let parsed: { data?: unknown; errors?: unknown } = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON error body; fall through with the raw text in the message
      }
    }

    if (!response.ok) {
      const detail = parsed.errors ? ` — ${JSON.stringify(parsed.errors)}` : "";
      throw new ProxmoxApiError(
        `${method} ${path} failed: ${response.status} ${response.statusText}${detail}`,
        response.status,
        method,
        path,
        parsed.errors,
      );
    }

    return parsed.data as T;
  }
}

function encodeParams(params?: Params): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Repeated form field, e.g. command=ls&command=-la
      for (const element of value) {
        if (element === undefined) continue;
        search.append(key, encodeScalar(element));
      }
      continue;
    }
    search.set(key, encodeScalar(value));
  }
  return search.toString();
}

/** Proxmox expects booleans as 1/0; everything else is stringified. */
function encodeScalar(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}
