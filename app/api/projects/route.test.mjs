import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { GET, POST } = await jiti.import("./route.ts");
const { DELETE } = await jiti.import("./[cwd]/route.ts");
const configModule = await jiti.import("../../../lib/project-config.ts");

const originalCwd = process.cwd();
const scratchDir = mkdtempSync(join(tmpdir(), "pi-web-projects-api-"));
process.chdir(scratchDir);
mkdirSync(join(scratchDir, "real-folder"), { recursive: true });
configModule._resetProjectConfigForTests();

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});

function reset() {
  configModule._resetProjectConfigForTests();
}

test("GET /api/projects returns empty list when conf.json has no entries", async () => {
  reset();
  const response = await GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.projects, []);
});

test("POST /api/projects registers a new project entry and persists it", async () => {
  reset();
  const folder = join(scratchDir, "real-folder");
  const response = await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.alreadyExisted, false);
  assert.equal(body.project.cwd, folder);
  assert.equal(typeof body.project.projectKey, "string");
  assert.ok(existsSyncConf());
});

function existsSyncConf() {
  try {
    readFileSync(join(scratchDir, "conf.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

test("POST /api/projects is idempotent for the same cwd", async () => {
  reset();
  const folder = join(scratchDir, "real-folder");
  await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const second = await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const body = await second.json();
  assert.equal(body.alreadyExisted, true);
  assert.equal(configModule.getConfiguredProjects().length, 1);
});

test("POST /api/projects rejects missing or non-existent cwd", async () => {
  reset();
  const empty = await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "" }),
  }));
  assert.equal(empty.status, 400);

  const missing = await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/no/such/place" }),
  }));
  assert.equal(missing.status, 400);
});

test("DELETE /api/projects/[cwd] unregisters a project and returns 404 when missing", async () => {
  reset();
  const folder = join(scratchDir, "real-folder");
  await POST(new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  }));
  const deleted = await DELETE(
    new Request(`http://localhost/api/projects/${encodeURIComponent(folder)}`, { method: "DELETE" }),
    { params: Promise.resolve({ cwd: encodeURIComponent(folder) }) },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { success: true, removed: true });
  assert.equal(configModule.getConfiguredProjects().length, 0);

  const missing = await DELETE(
    new Request(`http://localhost/api/projects/${encodeURIComponent(folder)}`, { method: "DELETE" }),
    { params: Promise.resolve({ cwd: encodeURIComponent(folder) }) },
  );
  assert.equal(missing.status, 404);
});
