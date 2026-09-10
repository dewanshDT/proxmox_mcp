import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const OWNED = [
  "PROXMOX_HOST",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_ALLOW_SELF_SIGNED",
  "PROXMOX_READONLY",
  "PROXMOX_WRITE_TOOLS",
  "MCP_AUTH_TOKEN",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "MCP_ALLOW_NO_AUTH",
];

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const key of OWNED) delete process.env[key];
  process.env.PROXMOX_HOST = "192.168.1.10";
  process.env.PROXMOX_TOKEN_ID = "mcp@pve!test";
  process.env.PROXMOX_TOKEN_SECRET = "secret";
  process.env.MCP_AUTH_TOKEN = "bearer-token";
});

afterEach(() => {
  process.env = saved;
});

// ---- host normalisation ----

test("a bare host gains both the https scheme and the :8006 port", () => {
  process.env.PROXMOX_HOST = "192.168.1.10";
  assert.equal(loadConfig().proxmox.host, "https://192.168.1.10:8006");
});

test("an explicit port is preserved", () => {
  process.env.PROXMOX_HOST = "192.168.1.10:8007";
  assert.equal(loadConfig().proxmox.host, "https://192.168.1.10:8007");
});

test("an https URL without a port still gains :8006", () => {
  process.env.PROXMOX_HOST = "https://pve.local";
  assert.equal(loadConfig().proxmox.host, "https://pve.local:8006");
});

test("an http scheme is not silently upgraded", () => {
  process.env.PROXMOX_HOST = "http://pve.local:8006";
  assert.equal(loadConfig().proxmox.host, "http://pve.local:8006");
});

test("a trailing slash does not produce a doubled separator", () => {
  process.env.PROXMOX_HOST = "https://pve.local/";
  assert.equal(loadConfig().proxmox.host, "https://pve.local:8006");
});

// ---- required variables ----

for (const missing of ["PROXMOX_HOST", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]) {
  test(`${missing} is required`, () => {
    delete process.env[missing];
    assert.throws(() => loadConfig(), new RegExp(missing));
  });
}

test("MCP_AUTH_TOKEN is required by default", () => {
  delete process.env.MCP_AUTH_TOKEN;
  assert.throws(() => loadConfig(), /MCP_AUTH_TOKEN/);
});

test("MCP_ALLOW_NO_AUTH=true is the documented escape hatch", () => {
  delete process.env.MCP_AUTH_TOKEN;
  process.env.MCP_ALLOW_NO_AUTH = "true";
  assert.equal(loadConfig().http.authToken, undefined);
});

test("MCP_ALLOW_NO_AUTH=false does not disable the requirement", () => {
  delete process.env.MCP_AUTH_TOKEN;
  process.env.MCP_ALLOW_NO_AUTH = "false";
  assert.throws(() => loadConfig(), /MCP_AUTH_TOKEN/);
});

// ---- port ----

test("MCP_HTTP_PORT defaults to 3000 and binds 0.0.0.0", () => {
  const { http } = loadConfig();
  assert.equal(http.port, 3000);
  assert.equal(http.host, "0.0.0.0");
});

test("a valid MCP_HTTP_PORT is used", () => {
  process.env.MCP_HTTP_PORT = "8080";
  assert.equal(loadConfig().http.port, 8080);
});

for (const bad of ["abc", "0", "70000", "3000.5", ""]) {
  test(`MCP_HTTP_PORT=${JSON.stringify(bad)} is rejected`, () => {
    process.env.MCP_HTTP_PORT = bad;
    assert.throws(() => loadConfig());
  });
}

// ---- boolean flags ----

for (const truthy of ["1", "true", "TRUE", "yes", "Yes"]) {
  test(`PROXMOX_READONLY=${truthy} enables read-only mode`, () => {
    process.env.PROXMOX_READONLY = truthy;
    assert.equal(loadConfig().readonly, true);
  });
}

for (const falsy of ["0", "false", "no", "off", ""]) {
  test(`PROXMOX_READONLY=${JSON.stringify(falsy)} leaves write tools enabled`, () => {
    process.env.PROXMOX_READONLY = falsy;
    assert.equal(loadConfig().readonly, false);
  });
}

test("PROXMOX_READONLY defaults to false", () => {
  assert.equal(loadConfig().readonly, false);
});

test("PROXMOX_ALLOW_SELF_SIGNED is read into the client config", () => {
  process.env.PROXMOX_ALLOW_SELF_SIGNED = "true";
  assert.equal(loadConfig().proxmox.allowSelfSigned, true);
});

// ---- PROXMOX_WRITE_TOOLS → effective (bridged, readonly-resolved) list ----

/** Run `fn` with a capturing no-op `console.error`; restore it afterwards. */
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test("PROXMOX_WRITE_TOOLS + PROXMOX_READONLY both unset bridges to lifecycle,snapshot", () => {
  const { result, lines } = captureStderr(() => loadConfig());
  assert.deepEqual(result.writeTools, ["lifecycle", "snapshot"]);
  // deprecation warning names the env var the operator should set
  assert.ok(lines.some((l) => l.includes("PROXMOX_WRITE_TOOLS")));
  // the bridge never pulls in the opt-in-only groups
  assert.ok(!result.writeTools.includes("destructive"));
  assert.ok(!result.writeTools.includes("exec"));
});

test("PROXMOX_READONLY=true + PROXMOX_WRITE_TOOLS unset yields an empty list, no crash", () => {
  process.env.PROXMOX_READONLY = "true";
  const { result, lines } = captureStderr(() => loadConfig());
  assert.deepEqual(result.writeTools, []);
  assert.deepEqual(lines, []); // nothing to warn about — no raw list was given
});

test("PROXMOX_READONLY=true overrides PROXMOX_WRITE_TOOLS=all and warns", () => {
  process.env.PROXMOX_READONLY = "true";
  process.env.PROXMOX_WRITE_TOOLS = "all";
  const { result, lines } = captureStderr(() => loadConfig());
  assert.deepEqual(result.writeTools, []);
  assert.ok(lines.some((l) => l.includes("PROXMOX_READONLY")));
});

test("an explicit non-empty PROXMOX_WRITE_TOOLS passes through unchanged, no warning", () => {
  process.env.PROXMOX_WRITE_TOOLS = "destructive";
  const { result, lines } = captureStderr(() => loadConfig());
  assert.deepEqual(result.writeTools, ["destructive"]);
  assert.deepEqual(lines, []);
});

test("PROXMOX_WRITE_TOOLS is split into trimmed tokens", () => {
  process.env.PROXMOX_WRITE_TOOLS = "lifecycle,snapshot";
  assert.deepEqual(loadConfig().writeTools, ["lifecycle", "snapshot"]);
});

test("PROXMOX_WRITE_TOOLS drops surrounding whitespace and empty entries", () => {
  process.env.PROXMOX_WRITE_TOOLS = "a, b ,c,";
  assert.deepEqual(loadConfig().writeTools, ["a", "b", "c"]);
});

test("PROXMOX_WRITE_TOOLS is lower-cased", () => {
  process.env.PROXMOX_WRITE_TOOLS = "Lifecycle";
  assert.deepEqual(loadConfig().writeTools, ["lifecycle"]);
});

test("PROXMOX_WRITE_TOOLS of only whitespace parses empty, so the bridge fires", () => {
  process.env.PROXMOX_WRITE_TOOLS = "  ";
  const { result } = captureStderr(() => loadConfig());
  assert.deepEqual(result.writeTools, ["lifecycle", "snapshot"]);
});
