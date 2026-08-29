"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  FileTreeDirectoryHandle,
  GitStatusEntry,
  GitStatus as PierreGitStatus,
} from "@pierre/trees";
import { useI18n } from "@/hooks/useI18n";
import { getRelativeFilePath, joinFilePath } from "@/lib/file-paths";

interface Props {
  cwd: string | null;
  onOpenFile: (filePath: string) => void;
  refreshKey?: number;
  // Absolute path of the file currently shown in the right-side FileViewer.
  // The tree highlights the matching row and scrolls it into view so the user
  // can see which file is open, even when the open was triggered from
  // outside the tree (e.g. an @-mention in chat).
  activeFilePath?: string | null;
}

// CSS attribute selector values need `\` and `"` escaped; other characters
// that appear in file paths (`.`, `/`, `:`, spaces, parentheses) are valid
// inside a CSS string and pass through unchanged.
function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Build the canonical directory paths that contain `filePath`, from the root
// toward the leaf. Mirrors `getAncestorDirectoryPaths` inside @pierre/trees
// (which is internal) so we can expand the chain to make a deep file visible.
function getAncestorDirectoryPaths(filePath: string): string[] {
  const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
  if (normalized.length === 0) return [];
  const segments = normalized.split("/");
  return segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);
}

// Type guard that narrows the generic item handle union down to a directory
// handle whose `expand` method is safe to call. Also filters out directories
// that are already expanded so the call is a no-op.
function isCollapsedDirectory(handle: unknown): handle is FileTreeDirectoryHandle {
  if (handle == null || typeof handle !== "object") return false;
  const candidate = handle as {
    isDirectory?: () => boolean;
    isExpanded?: () => boolean;
    expand?: () => void;
  };
  return (
    candidate.isDirectory?.() === true &&
    candidate.isExpanded?.() === false &&
    typeof candidate.expand === "function"
  );
}

// Mirrors the Git status kinds used by lib/git-types.ts so the icon badges
// line up with the existing FileExplorer until we wire the dedicated surface.
const GIT_STATUS_MAP: Record<string, PierreGitStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "untracked",
};

interface FileIndexResponse {
  files?: string[];
  truncated?: boolean;
  error?: string;
}

interface GitStatusResponse {
  files?: Array<{ filePath: string; status: string }>;
}

/**
 * Thin wrapper around @pierre/trees that sources its path list from the same
 * /api/file-index endpoint used by @-mention search. Renders alongside the
 * existing FileExplorer as a parallel tab so we can compare behavior.
 *
 * Trees exposes no row-activate callback, so single-click + Enter on a file
 * triggers the open via onSelectionChange when the selection collapses to the
 * currently focused row.
 */
export function PierreFileExplorer({ cwd, onOpenFile, refreshKey, activeFilePath }: Props) {
  const { t } = useI18n();
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatusEntry[]>([]);

  // Keep latest cwd + onOpenFile in refs so the trees model's stable
  // onSelectionChange closure always reads current values.
  const cwdRef = useRef(cwd);
  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);

  // Fetch the path list. The endpoint already enforces the allowed-roots
  // allow-list and caps the response at MAX_FILES.
  useEffect(() => {
    if (!cwd) {
      setPaths([]);
      setError(null);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`);
        const data = (await res.json().catch(() => ({}))) as FileIndexResponse;
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          setPaths([]);
          setTruncated(false);
          return;
        }
        const rel = data.files ?? [];
        // Trees treats its input as paths inside a single synthetic root, so
        // keep the cwd-relative form instead of joining the cwd prefix back on.
        setPaths(rel.length === 0 ? [] : Array.from(new Set(rel)));
        setTruncated(Boolean(data.truncated));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);

  // Fetch Git status best-effort. Mirrors the existing FileExplorer so both
  // tabs show consistent change indicators.
  useEffect(() => {
    if (!cwd) {
      setGitStatus([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as GitStatusResponse | null;
        if (cancelled || !data?.files) return;
        const mapped: GitStatusEntry[] = [];
        for (const f of data.files) {
          const status = GIT_STATUS_MAP[f.status];
          if (!status) continue;
          // Git endpoint emits absolute paths; trees wants cwd-relative
          // entries so the synthetic root matches the file-index list.
          const rel = f.filePath.startsWith(`${cwd}/`)
            ? f.filePath.slice(cwd.length + 1)
            : f.filePath;
          mapped.push({ path: rel, status });
        }
        setGitStatus(mapped);
      } catch {
        // Git status is best-effort; an unrelated repo state should not
        // disable the file tree.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);

  // useFileTree creates the model once; later path/status changes must flow
  // through the imperative methods below.
  const { model } = useFileTree({
    paths,
    search: true,
    fileTreeSearchMode: "hide-non-matches",
    // @pierre/path-store defaults flattenEmptyDirectories to true; disable it
    // so every directory level renders on its own row, matching the existing
    // FileExplorer behavior.
    flattenEmptyDirectories: false,
    density: "compact",
    onSelectionChange: (selectedPaths) => {
      if (selectedPaths.length !== 1) return;
      const selectedPath = selectedPaths[0];
      if (!selectedPath) return;
      // Arrow-key navigation changes focus without changing selection, so
      // requiring focus === path filters those out.
      if (model.getFocusedPath() !== selectedPath) return;
      const c = cwdRef.current;
      if (!c) return;
      // Defensive: paths are sourced from the cwd-scoped listing, but reject
      // anything that tries to escape via `..` or an absolute prefix.
      if (selectedPath.startsWith("/") || selectedPath.includes("..")) return;
      const item = model.getItem(selectedPath);
      if (!item || item.isDirectory()) return;
      // Resolve back to an absolute path for the FileViewer.
      onOpenFileRef.current(joinFilePath(c, selectedPath));
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Translate the absolute path of the currently open file (lives in
  // AppShell.openFile) into the cwd-relative form the tree stores in
  // `data-item-path`. The trees library only exposes `focusPath`/`scrollToPath`
  // for programmatic row targeting, and `unsafeCSS` is a one-shot mount-time
  // prop, so we drive highlighting via direct shadow-DOM style injection.
  const activeRelativePath = useMemo(() => {
    if (!activeFilePath || !cwd) return null;
    return getRelativeFilePath(activeFilePath, cwd);
  }, [activeFilePath, cwd]);

  useEffect(() => {
    // Walk the ancestor directory chain and expand each collapsed folder so
    // a deeply nested active file actually becomes visible. `getItem` returns
    // a handle only for paths the store knows about, so folders that have not
    // been listed yet are skipped (the effect re-runs once `paths` resolves
    // and picks them up). `expand()` is idempotent: it only mutates when the
    // folder is currently collapsed.
    if (activeRelativePath) {
      try {
        for (const ancestorPath of getAncestorDirectoryPaths(activeRelativePath)) {
          const ancestor = model.getItem(ancestorPath);
          if (isCollapsedDirectory(ancestor)) ancestor.expand();
        }
        model.focusPath(activeRelativePath);
        model.scrollToPath(activeRelativePath);
      } catch {
        // Defensive: model methods are best-effort and should not throw.
      }
    }

    // Mirror the same row's selected look inside the shadow root. The
    // library's `data-item-selected` attribute is only set by user clicks, so
    // we paint a single row ourselves with a path-targeted rule. Reach the
    // host element through the model (no React ref — the public component is
    // not `forwardRef`) and inject a single scoped <style> tag.
    const host = model.getFileTreeContainer?.();
    if (!host) return;
    const shadow = host.shadowRoot;
    if (shadow == null) return;
    let style = shadow.querySelector<HTMLStyleElement>("style[data-pierre-active-row]");
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-pierre-active-row", "");
      shadow.appendChild(style);
    }
    if (!activeRelativePath) {
      style.textContent = "";
      return;
    }
    const escaped = escapeCssAttributeValue(activeRelativePath);
    // Reuse the same palette as the selected-row override so the highlight
    // matches the focused-click appearance.
    style.textContent = `[data-type="item"][data-item-path="${escaped}"] { background-color: var(--trees-selected-bg); color: var(--trees-selected-fg); }`;
  }, [activeRelativePath, model, paths]);

  // Theme bridge: feed our app CSS variables into trees's override slots so
  // the panel blends in without us redefining every default.
  const themeStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--trees-bg-override": "var(--bg-panel)",
        "--trees-bg-muted-override": "var(--bg)",
        "--trees-fg-override": "var(--text)",
        "--trees-fg-muted-override": "var(--text-muted)",
        "--trees-border-color-override": "var(--border)",
        "--trees-accent-override": "var(--accent)",
        "--trees-focus-ring-color-override": "var(--accent)",
        "--trees-selected-bg-override": "var(--bg-selected)",
        "--trees-selected-fg-override": "var(--text)",
        "--trees-selected-focused-border-color-override": "var(--accent)",
        "--trees-input-bg-override": "var(--bg)",
        "--trees-search-bg-override": "var(--bg)",
        "--trees-search-fg-override": "var(--text)",
        "--trees-indent-guide-bg-override": "var(--border)",
        "--trees-scrollbar-thumb-override": "var(--text-dim)",
        "--trees-font-family-override": "var(--font-mono)",
        "--trees-font-size-override": "12px",
        // Library default leaves a 6px margin under the search container but
        // 0px between rows, so the search box visually "floats" above the
        // first row. Collapse the search margin to match the row rhythm and
        // keep a hairline gap between rows so selected/hover rows don't
        // touch their neighbors.
        "--trees-item-row-gap-override": "0px",
        "--trees-gap-override": "1px",
        "--trees-item-padding-x-override": "4px",
        "--trees-padding-inline-override": "4px",
        "--trees-git-modified-color-override": "#d6a84b",
        "--trees-git-added-color-override": "#4ade80",
        "--trees-git-deleted-color-override": "#f87171",
        "--trees-git-renamed-color-override": "#60a5fa",
        "--trees-git-untracked-color-override": "#4ade80",
      }) as CSSProperties,
    [],
  );

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        ...themeStyle,
      }}
    >
      {truncated && (
        <div
          role="status"
          style={{
            padding: "4px 10px",
            fontSize: 10,
            color: "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          {t("rightPanel.files2Truncated")}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        {!cwd ? (
          <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12 }}>
            {t("workspace.selectProject")}
          </div>
        ) : loading && paths.length === 0 ? (
          <div role="status" style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12 }}>
            {t("rightPanel.files2Loading")}
          </div>
        ) : error ? (
          <div role="alert" style={{ padding: "8px 12px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        ) : (
          <FileTree
            model={model}
            style={{ height: "100%", width: "100%" }}
            renderContextMenu={(item) => {
              if (item.kind === "directory") return null;
              return (
                <div
                  style={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 4,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
                    minWidth: 120,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      const c = cwdRef.current;
                      if (!c) return;
                      onOpenFileRef.current(joinFilePath(c, item.path));
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "4px 8px",
                      background: "transparent",
                      border: "none",
                      color: "var(--text)",
                      fontSize: 12,
                      textAlign: "left",
                      cursor: "pointer",
                      borderRadius: 4,
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = "transparent";
                    }}
                  >
                    {t("rightPanel.files2Open")}
                  </button>
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
