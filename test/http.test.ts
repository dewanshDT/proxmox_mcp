import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ProxmoxHttp, ProxmoxApiError } from "../src/client/http.js";

/**
 * These run against a real HTTP server rather than a mocked fetch, so the
 * assertions cover what actually goes on the wire: the PVEAPIToken header,
 * the /api2/json prefix, and Proxmox's form encoding and { data } envelope.
 */

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let baseUrl: string;
let captured: Captured | undefined;
let reply: { status: number; body: string; contentType: string };

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      res.writeHead(reply.status, { "Content-Type": reply.contentType });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = undefined;
  reply = { status: 200, body: JSON.stringify({ data: null }), contentType: "application/json" };
});

const client = () =>
  new ProxmoxHttp({ host: baseUrl, tokenId: "mcp@pve!test", tokenSecret: "s3cr3t" });

test("sends the PVEAPIToken header and prefixes /api2/json", async () => {
  reply.body = JSON.stringify({ data: { version: "9.1.1" } });

  const data = await client().get<{ version: string }>("/version");

  assert.equal(data.version, "9.1.1", "the { data } envelope should be unwrapped");
  assert.equal(captured?.headers.authorization, "PVEAPIToken=mcp@pve!test=s3cr3t");
  assert.equal(captured?.url, "/api2/json/version");
});

test("a trailing slash on the host does not double up in the path", async () => {
  const http = new ProxmoxHttp({
    host: `${baseUrl}/`,
    tokenId: "mcp@pve!test",
    tokenSecret: "s3cr3t",
  });
  await http.get("/version");
  assert.equal(captured?.url, "/api2/json/version");
});

test("GET params become a query string, with booleans as 1/0", async () => {
  await client().get("/cluster/resources", { type: "vm", full: true, quiet: false });
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "/api2/json/cluster/resources?type=vm&full=1&quiet=0");
});

test("undefined params are omitted rather than sent as the string 'undefined'", async () => {
  await client().get("/cluster/resources", { type: undefined });
  assert.equal(captured?.url, "/api2/json/cluster/resources");
});

test("POST params go in a urlencoded body, not the URL", async () => {
  await client().post("/nodes/pve/qemu/100/status/shutdown", { timeout: 30, forceStop: true });
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.url, "/api2/json/nodes/pve/qemu/100/status/shutdown");
  assert.equal(captured?.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(captured?.body, "timeout=30&forceStop=1");
});

test("an array param is form-encoded as a repeated key", async () => {
  await client().post("/nodes/pve/qemu/100/agent/exec", { command: ["ls", "-la"] });
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.body, "command=ls&command=-la");
});

test("a scalar and an array param coexist in one request", async () => {
  await client().post("/nodes/pve/qemu/100/agent/exec", {
    command: ["cat", "/etc/hostname"],
    "input-data": "hello",
  });
  assert.equal(
    captured?.body,
    "command=cat&command=%2Fetc%2Fhostname&input-data=hello",
  );
});

test("an empty array param produces no output for that key", async () => {
  await client().get("/cluster/resources", { type: "vm", command: [] });
  assert.equal(captured?.url, "/api2/json/cluster/resources?type=vm");
});

test("DELETE params go in the query string like GET", async () => {
  await client().delete("/nodes/pve/qemu/100/snapshot/pre-upgrade", { force: true });
  assert.equal(captured?.method, "DELETE");
  assert.equal(captured?.url, "/api2/json/nodes/pve/qemu/100/snapshot/pre-upgrade?force=1");
});

test("a non-2xx response becomes a ProxmoxApiError carrying request context", async () => {
  reply = {
    status: 403,
    body: JSON.stringify({ errors: { path: "Permission check failed" } }),
    contentType: "application/json",
  };

  await assert.rejects(
    () => client().get("/cluster/status"),
    (error: unknown) => {
      assert.ok(error instanceof ProxmoxApiError);
      assert.equal(error.status, 403);
      assert.equal(error.method, "GET");
      assert.equal(error.path, "/cluster/status");
      assert.match(error.message, /Permission check failed/, "Proxmox's own error should survive");
      return true;
    },
  );
});

test("a non-JSON error body does not mask the failure with a parse error", async () => {
  reply = { status: 500, body: "<html>upstream exploded</html>", contentType: "text/html" };

  await assert.rejects(
    () => client().get("/version"),
    (error: unknown) => error instanceof ProxmoxApiError && error.status === 500,
  );
});

test("an empty 200 body yields undefined instead of throwing", async () => {
  reply = { status: 200, body: "", contentType: "application/json" };
  assert.equal(await client().get("/nodes/pve/tasks"), undefined);
});
