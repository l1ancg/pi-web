import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { isAbsolute, join, resolve as resolvePath } from "path";
import { homedir } from "os";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * User-curated project list persisted to `conf.json` in the directory the
 * pi-web dev/prod server was launched from (i.e. `process.cwd()`). The list
 * is the only source of truth for what shows up under "Projects" in the
 * sidebar — sessions on disk whose cwd is not registered here are filtered
 * out of the session list.
 *
 * File shape:
 * ```json
 * {
 *   "projects": [
 *     { "cwd": "/abs/path", "addedAt": "2026-08-29T08:00:00.000Z" }
 *   ],
 *   "defaultCwd": "/abs/path"
 * }
 * ```
 *
 * `defaultCwd` (optional) marks a directory whose sub-tree is treated as the
 * "Recent" / scratch area: any session whose cwd lives under it (including
 * the directory itself) is shown under the Recent section instead of under
 * Projects. The `pi-cwd-*` scratch folders created by /api/default-cwd are
 * always admitted as Recent regardless of `defaultCwd`.
 */

const CONFIG_FILE_NAME = "conf.json";

export interface ConfiguredProject {
  cwd: string;
  addedAt: string;
}

interface ProjectConfigFile {
  projects: ConfiguredProject[];
  defaultCwd?: string | null;
}

function configFilePath(): string {
  return join(process.cwd(), CONFIG_FILE_NAME);
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Normalize a cwd to an absolute, normalized form for membership tests. */
export function normalizeProjectCwd(cwd: string): string {
  if (!cwd) return cwd;
  const trimmed = cwd.trim();
  if (!trimmed) return trimmed;
  const expanded = expandHome(trimmed);
  const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(expanded);
  return absolute;
}

function readConfigFile(): ProjectConfigFile {
  const filePath = configFilePath();
  if (!existsSync(filePath)) return { projects: [] };
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return { projects: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { projects: [] };
    }
    const value = parsed as { projects?: unknown; defaultCwd?: unknown };
    const projects: ConfiguredProject[] = [];
    if (Array.isArray(value.projects)) {
      for (const entry of value.projects) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const cwd = (entry as { cwd?: unknown }).cwd;
        if (typeof cwd !== "string" || !cwd.trim()) continue;
        const addedAt = (entry as { addedAt?: unknown }).addedAt;
        projects.push({
          cwd: cwd.trim(),
          addedAt: typeof addedAt === "string" && addedAt ? addedAt : new Date().toISOString(),
        });
      }
    }
    const defaultCwd = typeof value.defaultCwd === "string" && value.defaultCwd.trim()
      ? value.defaultCwd.trim()
      : null;
    return { projects, defaultCwd };
  } catch {
    // Corrupted config — fail closed with an empty list rather than crashing.
    return { projects: [] };
  }
}

function writeConfigFile(config: ProjectConfigFile): void {
  const filePath = configFilePath();
  const dir = resolvePath(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(config, null, 2) + "\n";
  writePrivateFileAtomicSync(filePath, json);
}

declare global {
  var __piProjectConfigCache: ProjectConfigFile | undefined;
}

function invalidateCache(): void {
  globalThis.__piProjectConfigCache = undefined;
}

function getCachedConfig(): ProjectConfigFile {
  if (!globalThis.__piProjectConfigCache) {
    globalThis.__piProjectConfigCache = readConfigFile();
  }
  return globalThis.__piProjectConfigCache;
}

export function getConfiguredProjects(): ConfiguredProject[] {
  return getCachedConfig().projects;
}

/** Normalized set of registered project cwds for fast membership tests. */
export function getConfiguredProjectCwdSet(): Set<string> {
  const set = new Set<string>();
  for (const project of getConfiguredProjects()) {
    set.add(normalizeProjectCwd(project.cwd));
  }
  return set;
}

export function isCwdConfigured(cwd: string): boolean {
  if (!cwd) return false;
  return getConfiguredProjectCwdSet().has(normalizeProjectCwd(cwd));
}

/** Register a cwd as a project. Idempotent: returns the existing entry if
 *  the same cwd is already present (after normalization). */
export function addConfiguredProject(cwd: string): ConfiguredProject {
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) throw new Error("cwd is required");
  const current = getCachedConfig();
  const existing = current.projects.find((p) => normalizeProjectCwd(p.cwd) === normalized);
  if (existing) return existing;
  const entry: ConfiguredProject = { cwd: normalized, addedAt: new Date().toISOString() };
  writeConfigFile({ ...current, projects: [...current.projects, entry] });
  invalidateCache();
  return entry;
}

export function removeConfiguredProject(cwd: string): boolean {
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) return false;
  const current = getCachedConfig();
  const filtered = current.projects.filter((p) => normalizeProjectCwd(p.cwd) !== normalized);
  if (filtered.length === current.projects.length) return false;
  writeConfigFile({ ...current, projects: filtered });
  invalidateCache();
  return true;
}

/** Returns the configured "Recent" root (or null when unset). */
export function getDefaultCwd(): string | null {
  return getCachedConfig().defaultCwd ?? null;
}

/** Set or clear the configured "Recent" root. Pass `null` to clear. */
export function setDefaultCwd(cwd: string | null): string | null {
  const current = getCachedConfig();
  if (cwd === null || cwd === "") {
    if (!current.defaultCwd) return null;
    writeConfigFile({ ...current, defaultCwd: null });
    invalidateCache();
    return null;
  }
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) throw new Error("cwd is required");
  if (current.defaultCwd && normalizeProjectCwd(current.defaultCwd) === normalized) {
    return current.defaultCwd;
  }
  writeConfigFile({ ...current, defaultCwd: normalized });
  invalidateCache();
  return normalized;
}

/** True when `cwd` lives under the configured default cwd (or is it). */
export function isUnderDefaultCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const defaultCwd = getDefaultCwd();
  if (!defaultCwd) return false;
  const normalized = normalizeProjectCwd(cwd);
  const normalizedDefault = normalizeProjectCwd(defaultCwd);
  if (normalized === normalizedDefault) return true;
  return normalized.startsWith(`${normalizedDefault}/`);
}

/**
 * Decide whether a session's cwd (or its resolved project root) is allowed
 * by the configured project list, the `defaultCwd` Recent root, or the
 * built-in `pi-cwd-*` scratch roots. Mirrors `isDefaultCwd()` on the client
 * so the server and UI agree on "Recent" placement.
 */
export function isSessionInConfiguredProjects(
  cwd: string | null | undefined,
  projectRoot: string | null | undefined,
  homeDir: string,
): boolean {
  const projects = getConfiguredProjectCwdSet();
  if (cwd) {
    const key = normalizeProjectCwd(cwd);
    if (projects.has(key)) return true;
    if (isDefaultScratchCwd(cwd, homeDir)) return true;
    if (isUnderDefaultCwd(cwd)) return true;
  }
  if (projectRoot) {
    const key = normalizeProjectCwd(projectRoot);
    if (projects.has(key)) return true;
    if (isUnderDefaultCwd(projectRoot)) return true;
  }
  return false;
}

/** Same shape the client uses in SessionSidebar's `isDefaultCwd`. */
export function isRecentCwd(cwd: string | null | undefined, homeDir: string): boolean {
  if (!cwd) return false;
  if (isDefaultScratchCwd(cwd, homeDir)) return true;
  if (isUnderDefaultCwd(cwd)) return true;
  return false;
}

function isDefaultScratchCwd(cwd: string, homeDir: string): boolean {
  if (!cwd || !homeDir) return false;
  if (cwd === homeDir) return false;
  return cwd.startsWith(`${homeDir}/pi-cwd-`);
}

/** For tests: reset cache and best-effort remove the conf.json file. */
export function _resetProjectConfigForTests(): void {
  invalidateCache();
  try {
    rmSync(configFilePath(), { force: true });
  } catch {
    /* ignore */
  }
}
