import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessApi } from "../src/endpoints/access.js";
import type { ProxmoxHttp } from "../src/client/http.js";
import type { EffectivePermissions } from "../src/types/index.js";

/**
 * Preflight resolves the token's real ACL through this one endpoint. It must hit
 * `/access/permissions` and pass `path` as a query param only when the caller
 * gives one — with no argument the request carries no `?path=`.
 */

type GetCall = { path: string; params?: Record<string, unknown> };

function stubbedAccess(resolved: EffectivePermissions) {
  const calls: GetCall[] = [];
  const http = {
    get: async (path: string, params?: Record<string, unknown>) => {
      calls.push({ path, params });
      return resolved;
    },
  };
  return { api: new AccessApi(http as unknown as ProxmoxHttp), calls };
}

test("permissions() with no path GETs /access/permissions and leaves path undefined", async () => {
  const { api, calls } = stubbedAccess({});

  await api.permissions();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/access/permissions");
  assert.ok(calls[0].params, "params object is passed through to http.get");
  assert.equal(calls[0].params!.path, undefined);
});

test("permissions(path) forwards the path as a query param", async () => {
  const { api, calls } = stubbedAccess({});

  await api.permissions("/vms/100");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/access/permissions");
  assert.equal(calls[0].params!.path, "/vms/100");
});

test("the http response passes straight through", async () => {
  const acl: EffectivePermissions = {
    "/vms/100": { "VM.PowerMgmt": 0, "VM.Snapshot": 1 },
    "/": { "VM.Audit": 1 },
  };
  const { api } = stubbedAccess(acl);

  const result = await api.permissions("/vms/100");

  assert.deepEqual(result, acl);
});
