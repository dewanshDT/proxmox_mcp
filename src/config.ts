import type { ProxmoxConfig } from "./client/http.js";

export interface HttpConfig {
  /** Port to listen on. Default: 3000 */
  port: number;
  /** Address to bind. Default: 0.0.0.0 (LAN-reachable inside a container) */
  host: string;
  /**
   * Bearer token clients must present. Required unless MCP_ALLOW_NO_AUTH=true,
   * because the write tools are destructive (guest stop, snapshot rollback).
   */
  authToken?: string;
}

export interface ServerConfig {
  proxmox: ProxmoxConfig;
  readonly: boolean;
  http: HttpConfig;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set PROXMOX_HOST, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET.`,
    );
  }
  return value;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes"].includes(value.toLowerCase());
}

export function loadConfig(): ServerConfig {
  let host = required("PROXMOX_HOST");
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  if (!/:\d+/.test(new URL(host).host)) host = `${host.replace(/\/+$/, "")}:8006`;

  const port = Number(process.env.MCP_HTTP_PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
  }

  const authToken = process.env.MCP_AUTH_TOKEN;
  if (!authToken && !isTruthy(process.env.MCP_ALLOW_NO_AUTH)) {
    throw new Error(
      "Missing MCP_AUTH_TOKEN. This server is reachable over the network and its write " +
        "tools are destructive, so a bearer token is required. Set MCP_AUTH_TOKEN, or set " +
        "MCP_ALLOW_NO_AUTH=true to run without auth (only on a trusted, isolated network).",
    );
  }

  return {
    proxmox: {
      host,
      tokenId: required("PROXMOX_TOKEN_ID"),
      tokenSecret: required("PROXMOX_TOKEN_SECRET"),
      allowSelfSigned: isTruthy(process.env.PROXMOX_ALLOW_SELF_SIGNED),
    },
    readonly: isTruthy(process.env.PROXMOX_READONLY),
    http: {
      port,
      host: process.env.MCP_HTTP_HOST ?? "0.0.0.0",
      authToken,
    },
  };
}
