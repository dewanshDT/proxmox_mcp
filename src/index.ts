#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ProxmoxClient } from "./client/api.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./mcp/tools.js";

const MCP_PATH = "/mcp";

async function main(): Promise<void> {
  const config = loadConfig();
  const proxmox = new ProxmoxClient(config.proxmox);

  const app = express();
  app.use(express.json());

  // Health check — unauthenticated, for Docker/monitoring probes.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Bearer-token auth for everything under /mcp.
  app.use(MCP_PATH, requireAuth(config.http.authToken));

  // Streamable HTTP is stateless here: each request gets a fresh McpServer +
  // transport. The tools carry no per-client state, so there is nothing to
  // keep between requests — this keeps multiple LAN clients fully isolated.
  app.post(MCP_PATH, async (req: Request, res: Response) => {
    const server = new McpServer({ name: "proxmox-mcp", version: "0.2.0" });
    registerTools(server, proxmox, { readonly: config.readonly });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no sessions, so the SSE-stream (GET) and session-teardown
  // (DELETE) endpoints do not apply.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
  };
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);

  const { port, host } = config.http;
  app.listen(port, host, () => {
    // Logging goes to stderr by convention; stdout is free now that we no
    // longer speak the stdio MCP protocol.
    const auth = config.http.authToken ? "bearer auth" : "NO AUTH";
    console.error(
      `proxmox-mcp listening on http://${host}:${port}${MCP_PATH} ` +
        `(${config.proxmox.host}, ${config.readonly ? "read-only" : "read-write"}, ${auth})`,
    );
  });
}

/** Express middleware: constant-time compare of the Bearer token. */
function requireAuth(expected: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expected) {
      next(); // MCP_ALLOW_NO_AUTH — auth intentionally disabled.
      return;
    }

    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && safeEqual(match[1], expected)) {
      next();
      return;
    }

    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };
}

/** Length-safe, timing-safe string comparison. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
