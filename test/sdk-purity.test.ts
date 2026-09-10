import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/**
 * Invariant #3: `src/client/` and `src/endpoints/` are a standalone Proxmox SDK
 * and never import from the MCP layer — neither the local `src/mcp/` nor the
 * `@modelcontextprotocol/*` packages. If that boundary breaks the SDK stops
 * being reusable for a CLI or dashboard, so this test guards it in CI.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_DIRS = ["src/client", "src/endpoints"].map((d) => join(REPO_ROOT, d));

/** Every `.ts` file under the given directory, recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The module specifiers of every static and dynamic import/export in `source`.
 * Deliberately reads only the specifier string, so the word "mcp" in a comment
 * or an unrelated string literal cannot trip the guard.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    // import ... from "x"  /  export ... from "x"
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
    // bare side-effect import "x"
    /\bimport\s*["']([^"']+)["']/g,
    // dynamic import("x")  /  require("x")
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Does this module specifier reference the MCP layer? */
function referencesMcp(spec: string): boolean {
  const s = spec.toLowerCase();
  return s.includes("mcp") || s.includes("modelcontextprotocol");
}

test("the SDK layer imports nothing from the MCP layer", () => {
  const offences: string[] = [];
  let scanned = 0;

  for (const dir of SDK_DIRS) {
    for (const file of tsFilesUnder(dir)) {
      scanned++;
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        if (referencesMcp(spec)) {
          offences.push(`${relative(REPO_ROOT, file)} imports "${spec}"`);
        }
      }
    }
  }

  assert.ok(scanned > 0, "expected to scan at least one SDK source file");
  assert.deepEqual(
    offences,
    [],
    `SDK files must not import the MCP layer:\n  ${offences.join("\n  ")}`,
  );
});

test("the scan actually covers the SDK source tree", () => {
  const covered = new Set(
    SDK_DIRS.flatMap((dir) => tsFilesUnder(dir)).map((f) => relative(REPO_ROOT, f)),
  );

  for (const expected of [
    "src/client/api.ts",
    "src/client/http.ts",
    "src/endpoints/tasks.ts",
    "src/endpoints/snapshots.ts",
  ]) {
    assert.ok(covered.has(expected), `${expected} should be part of the purity scan`);
  }
});

test("the import-specifier matcher is precise", () => {
  // Extracted specifiers that must be flagged.
  for (const spec of [
    "../mcp/tools.js",
    "./mcp/register.js",
    "@modelcontextprotocol/sdk/server/mcp.js",
  ]) {
    assert.ok(referencesMcp(spec), `${spec} should be flagged`);
  }

  // Specifiers that must NOT be flagged.
  for (const spec of ["../client/http.js", "../types/index.js", "undici", "node:fs"]) {
    assert.ok(!referencesMcp(spec), `${spec} should not be flagged`);
  }

  // "mcp" outside an import specifier must not register at all.
  const decoy = [
    '// the token id looks like "mcp@pve!homelab"',
    'const note = "this mentions mcp and @modelcontextprotocol on purpose";',
    'import { TasksApi } from "../endpoints/tasks.js";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(decoy), ["../endpoints/tasks.js"]);
  assert.ok(!importSpecifiers(decoy).some(referencesMcp));
});
