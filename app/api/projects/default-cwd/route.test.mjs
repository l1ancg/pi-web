import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { GET, PUT } = await jiti.import("./route.ts");
const configModule = await jiti.import("../../../../lib/project-config.ts");

const originalCwd = process.cwd();
const scratchDir = mkdtempSync(join(tmpdir(), "pi-web-default-cwd-api-"));
process.chdir(scratchDir);
mkdirSync(join(scratchDir, "scratch-folder"), { recursive: true });
configModule._resetProjectConfigForTests();

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});

function reset() {
  configModule._resetProjectConfigForTests();
}

test("GET /api/projects/default-cwd returns null when unset", async () => {
  reset();
  const response = await GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.defaultCwd, null);
});

test("PUT /api/projects/default-cwd stores a new default cwd", async () => {
  reset();
  const folder = join(scratchDir, "scratch-folder");
  const put = await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const putBody = await put.json();
  assert.equal(put.status, 200);
  assert.equal(putBody.success, true);
  assert.equal(putBody.defaultCwd, folder);

  const get = await GET();
  const getBody = await get.json();
  assert.equal(getBody.defaultCwd, folder);
});

test("PUT /api/projects/default-cwd accepts null to clear", async () => {
  reset();
  const folder = join(scratchDir, "scratch-folder");
  await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const clear = await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: null }),
  }));
  const body = await clear.json();
  assert.equal(clear.status, 200);
  assert.equal(body.defaultCwd, null);
  assert.equal(configModule.getDefaultCwd(), null);
});

test("PUT /api/projects/default-cwd rejects missing or non-existent paths", async () => {
  reset();
  const empty = await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "" }),
  }));
  assert.equal(empty.status, 400);

  const missing = await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/no/such/place" }),
  }));
  assert.equal(missing.status, 400);
});

test("PUT /api/projects/default-cwd is idempotent for the same path", async () => {
  reset();
  const folder = join(scratchDir, "scratch-folder");
  await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const second = await PUT(new Request("http://localhost/api/projects/default-cwd", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  assert.equal(second.status, 200);
  assert.equal(configModule.getDefaultCwd(), folder);
});
