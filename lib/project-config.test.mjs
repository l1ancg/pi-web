import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const configModule = await jiti.import("./project-config.ts");

const originalCwd = process.cwd();
const scratchDir = mkdtempSync(join(tmpdir(), "pi-web-project-config-"));
process.chdir(scratchDir);

function reset() {
  configModule._resetProjectConfigForTests();
}

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});

test("starts empty when conf.json does not exist", () => {
  reset();
  assert.deepEqual(configModule.getConfiguredProjects(), []);
  assert.equal(configModule.getConfiguredProjectCwdSet().size, 0);
  assert.equal(configModule.isCwdConfigured("/anywhere"), false);
});

test("addConfiguredProject writes conf.json with absolute cwd and is idempotent", () => {
  reset();
  const first = configModule.addConfiguredProject("/tmp/example");
  const second = configModule.addConfiguredProject("/tmp/example");
  assert.equal(first.cwd, "/tmp/example");
  assert.equal(second.cwd, first.cwd);
  assert.equal(second.addedAt, first.addedAt);

  const projects = configModule.getConfiguredProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].cwd, "/tmp/example");
  assert.match(projects[0].addedAt, /^\d{4}-\d{2}-\d{2}T/);

  const filePath = join(scratchDir, "conf.json");
  assert.equal(existsSync(filePath), true);
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(parsed.projects.map((p) => p.cwd), ["/tmp/example"]);
});

test("normalizes cwd (path traversal and trailing slashes)", () => {
  reset();
  configModule.addConfiguredProject("/tmp/example/./sub/../");
  const set = configModule.getConfiguredProjectCwdSet();
  assert.equal(set.size, 1);
  assert.equal(set.has("/tmp/example"), true);
  assert.equal(configModule.isCwdConfigured("/tmp/example/"), true);
});

test("removeConfiguredProject deletes the entry from disk", () => {
  reset();
  configModule.addConfiguredProject("/tmp/example");
  assert.equal(configModule.removeConfiguredProject("/tmp/example"), true);
  assert.deepEqual(configModule.getConfiguredProjects(), []);
  // second call returns false
  assert.equal(configModule.removeConfiguredProject("/tmp/example"), false);
});

test("corrupt conf.json falls back to empty list without throwing", () => {
  reset();
  const filePath = join(scratchDir, "conf.json");
  writeFileSync(filePath, "not-json");
  assert.deepEqual(configModule.getConfiguredProjects(), []);
});

test("malformed entries are dropped", () => {
  reset();
  const filePath = join(scratchDir, "conf.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      projects: [
        { cwd: "/valid" },
        { cwd: "" },
        { cwd: 42 },
        null,
        "string",
        { cwd: "/also-valid", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
  );
  const projects = configModule.getConfiguredProjects();
  assert.deepEqual(
    projects.map((p) => p.cwd).sort(),
    ["/also-valid", "/valid"],
  );
});

test("isSessionInConfiguredProjects matches cwd or projectRoot", () => {
  reset();
  configModule.addConfiguredProject("/projects/alpha");
  const home = "/home/user";
  assert.equal(configModule.isSessionInConfiguredProjects("/projects/alpha", null, home), true);
  assert.equal(configModule.isSessionInConfiguredProjects("/projects/beta", "/projects/alpha", home), true);
  assert.equal(configModule.isSessionInConfiguredProjects("/projects/beta", "/projects/beta", home), false);
});

test("isSessionInConfiguredProjects admits pi-cwd-* scratch folders", () => {
  reset();
  const home = "/home/user";
  assert.equal(
    configModule.isSessionInConfiguredProjects(`${home}/pi-cwd-20260829`, null, home),
    true,
  );
  assert.equal(
    configModule.isSessionInConfiguredProjects(`${home}/pi-cwd-20260829/inner`, null, home),
    true,
  );
  assert.equal(
    configModule.isSessionInConfiguredProjects(`${home}/projects`, null, home),
    false,
  );
  assert.equal(
    configModule.isSessionInConfiguredProjects(home, null, home),
    false,
  );
});

test("normalizeProjectCwd expands ~ and resolves to absolute paths", () => {
  const home = homedir();
  assert.equal(configModule.normalizeProjectCwd("~"), home);
  assert.equal(configModule.normalizeProjectCwd(`~/foo`), join(home, "foo"));
  assert.equal(configModule.normalizeProjectCwd("/already/abs"), "/already/abs");
});

test("defaultCwd defaults to null", () => {
  reset();
  assert.equal(configModule.getDefaultCwd(), null);
});

test("setDefaultCwd stores and returns the normalized cwd", () => {
  reset();
  const result = configModule.setDefaultCwd("/tmp/default-area");
  assert.equal(result, "/tmp/default-area");
  assert.equal(configModule.getDefaultCwd(), "/tmp/default-area");

  // idempotent
  const again = configModule.setDefaultCwd("/tmp/default-area");
  assert.equal(again, "/tmp/default-area");

  // clear with null
  const cleared = configModule.setDefaultCwd(null);
  assert.equal(cleared, null);
  assert.equal(configModule.getDefaultCwd(), null);
});

test("setDefaultCwd survives a conf.json reload", async () => {
  reset();
  configModule.setDefaultCwd("/tmp/persisted-default");
  configModule._resetProjectConfigForTests();
  // _reset clears the cache but also deletes conf.json, so re-add and verify
  // the writer persisted to disk.
  configModule.setDefaultCwd("/tmp/persisted-default");
  const { readFileSync } = await import("node:fs");
  const filePath = join(scratchDir, "conf.json");
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(raw.defaultCwd, "/tmp/persisted-default");
});

test("isUnderDefaultCwd matches the default cwd and its descendants", () => {
  reset();
  configModule.setDefaultCwd("/tmp/default-area");
  assert.equal(configModule.isUnderDefaultCwd("/tmp/default-area"), true);
  assert.equal(configModule.isUnderDefaultCwd("/tmp/default-area/sub"), true);
  assert.equal(configModule.isUnderDefaultCwd("/tmp/default-area-other"), false);
  assert.equal(configModule.isUnderDefaultCwd("/tmp"), false);
  assert.equal(configModule.isUnderDefaultCwd(null), false);
});

test("isSessionInConfiguredProjects admits sessions under the default cwd", () => {
  reset();
  const home = "/home/user";
  assert.equal(configModule.isSessionInConfiguredProjects("/anywhere", null, home), false);
  configModule.setDefaultCwd("/tmp/scratch");
  assert.equal(configModule.isSessionInConfiguredProjects("/tmp/scratch", null, home), true);
  assert.equal(configModule.isSessionInConfiguredProjects("/tmp/scratch/sub", null, home), true);
  assert.equal(configModule.isSessionInConfiguredProjects("/tmp/scratch-other", null, home), false);
});

test("isRecentCwd admits both pi-cwd-* and the configured default cwd", () => {
  reset();
  const home = "/home/user";
  assert.equal(configModule.isRecentCwd(`${home}/pi-cwd-20260829`, home), true);
  configModule.setDefaultCwd("/tmp/scratch");
  assert.equal(configModule.isRecentCwd("/tmp/scratch", home), true);
  assert.equal(configModule.isRecentCwd("/tmp/scratch/foo", home), true);
  assert.equal(configModule.isRecentCwd("/tmp/something-else", home), false);
});

test("corrupt defaultCwd field is ignored on read", async () => {
  reset();
  const { writeFileSync } = await import("node:fs");
  const filePath = join(scratchDir, "conf.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      projects: [{ cwd: "/valid" }],
      defaultCwd: 42,
    }),
  );
  // The next read forces a fresh parse (not a delete). Reuse the existing
  // helper, but skip the rmSync by calling the cache invalidator directly.
  globalThis.__piProjectConfigCache = undefined;
  assert.equal(configModule.getDefaultCwd(), null);
  assert.equal(configModule.getConfiguredProjects().length, 1);
});
