"use client";

import { useEffect, useMemo, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "@/lib/git-types";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  cwd: string | null;
  refreshKey?: number;
}

// Mirrors the badge palette used by FileExplorer so the review surface and
// the existing changes panel look identical at a glance. Kept private here on
// purpose: the requirement is that FileExplorer must not change, so this
// component carries its own copy of the helper.
const STATUS_COLORS: Record<GitFileStatus["status"], string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status }: { status: GitFileStatus }) {
  return (
    <span
      title={`${status.status}: ${status.filePath}`}
      aria-label={`${status.status}: ${status.filePath}`}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: STATUS_COLORS[status.status] ?? "var(--text-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

/**
 * Review tab body: lists locally changed files (git status) and renders the
 * selected file's unified diff using @pierre/diffs. Data flows through the
 * existing /api/git/status and /api/git/diff endpoints, so the surface shares
 * the same git plumbing as FileExplorer without coupling to its UI.
 */
interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  status: GitFileStatus;
}

interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
}

type TreeNode = TreeFolder | TreeFile;

/**
 * Build a folder hierarchy from the flat cwd-relative file list. Folders
 * are deduplicated, kept in insertion order, and decorated with a
 * transitive file count so the UI can label them without re-walking.
 */
function buildReviewTree(files: GitFileStatus[]): TreeNode[] {
  const sorted = [...files].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const roots: TreeNode[] = [];
  for (const file of sorted) {
    const segments = file.filePath.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments.pop()!;
    let level = roots;
    let folderPath = "";
    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      let next = level.find((n): n is TreeFolder => n.kind === "folder" && n.name === segment);
      if (!next) {
        next = { kind: "folder", name: segment, path: folderPath, children: [], fileCount: 0 };
        level.push(next);
      }
      next.fileCount += 1;
      level = next.children;
    }
    level.push({ kind: "file", name: fileName, path: file.filePath, status: file });
  }
  return roots;
}

export function ReviewPanel({ cwd, refreshKey }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );

  // Fetch git status. Clears stale state on cwd / refresh changes.
  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      setStatusError(null);
      return;
    }
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
        const data = (await res.json().catch(() => null)) as
          | GitStatusResponse
          | { error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !data || !("files" in data)) {
          setStatusError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
          setStatus(null);
          return;
        }
        setStatus(data);
        // Auto-pick the first file so the diff pane has content on entry.
        setSelectedFile((prev) => prev ?? data.files?.[0]?.filePath ?? null);
      } catch (e) {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);

  // Reset selection on cwd change so we don't keep an out-of-cwd path.
  useEffect(() => {
    setSelectedFile(null);
    setDiff(null);
  }, [cwd]);

  // Fetch the diff for the currently selected file.
  useEffect(() => {
    if (!cwd || !selectedFile) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ cwd, path: selectedFile });
        const res = await fetch(`/api/git/diff?${params.toString()}`);
        const data = (await res.json().catch(() => null)) as
          | GitFileDiffResponse
          | { error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !data || !("supported" in data)) {
          setDiff({ supported: false });
          return;
        }
        setDiff(data);
      } catch {
        if (!cancelled) setDiff({ supported: false });
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFile, cwd]);

  const diffOptions = useMemo<FileDiffOptions<undefined>>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      // The Review tab is always rendered against the dark palette that the
      // rest of the app uses; force dark so the diff theme matches even when
      // the OS preference flips.
      themeType: "dark",
      diffStyle: "unified",
      overflow: "wrap",
      // --diffs-bg has no -override slot in pierre-dark; unsafeCSS lets us
      // rebind it to the app surface color. deletion/addition line tints are
      // color-mix(<bg> 80%, red/green) so they keep their hue while reading
      // against the app background.
      unsafeCSS: [
        ":host { --diffs-bg: var(--bg); }",
        "pre, code { background-color: var(--diffs-bg); }",
      ].join("\n"),
    }),
    [],
  );

  const files = useMemo(() => status?.files ?? [], [status]);
  const tree = useMemo(() => buildReviewTree(files), [files]);
  // Auto-expand every folder whenever the tree changes so the working set
  // is fully visible by default; explicit user collapses for paths that
  // are still in the tree are preserved (the effect only adds, never removes).
  useEffect(() => {
    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      const collect = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          if (node.kind === "folder" && !next.has(node.path)) {
            next.add(node.path);
            changed = true;
          }
          if (node.kind === "folder") {
            collect(node.children);
          }
        }
      };
      collect(tree);
      return changed ? next : prev;
    });
  }, [tree]);
  const hasFiles = files.length > 0;
  const selectedStatus = selectedFile
    ? files.find((f) => f.filePath === selectedFile)
    : null;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          padding: "2px 4px 2px 10px",
          borderBottom: "1px solid var(--border)",
          minHeight: 32,
          color: "var(--text-dim)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          gap: 8,
        }}
      >
        <span>{t("rightPanel.reviewHeader")}</span>
        {status && hasFiles && (
          <>
            <span style={{ color: "#4ade80", fontFamily: "var(--font-mono)" }}>
              +{status.additions}
            </span>
            <span style={{ color: "#f87171", fontFamily: "var(--font-mono)" }}>
              −{status.deletions}
            </span>
          </>
        )}
      </div>

      {!cwd ? (
        <EmptyState>{t("workspace.selectProject")}</EmptyState>
      ) : statusLoading && !status ? (
        <EmptyState>{t("rightPanel.reviewLoading")}</EmptyState>
      ) : statusError ? (
        <EmptyState tone="error">{statusError}</EmptyState>
      ) : status && !status.isGitRepository ? (
        <EmptyState>{t("rightPanel.reviewNotARepository")}</EmptyState>
      ) : status && !hasFiles ? (
        <EmptyState>{t("rightPanel.reviewEmpty")}</EmptyState>
      ) : (
        <>
          <div
            style={{
              flexShrink: 0,
              maxHeight: 220,
              overflowY: "auto",
              overflowX: "hidden",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <ReviewTree
              nodes={tree}
              depth={0}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              expandedPaths={expandedPaths}
              onToggleFolder={(folderPath) =>
                setExpandedPaths((prev) => {
                  const next = new Set(prev);
                  if (next.has(folderPath)) next.delete(folderPath);
                  else next.add(folderPath);
                  return next;
                })
              }
            />
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
              padding: "0",
            }}
          >
            {selectedFile && (
              <DiffBody
                cwd={cwd}
                filePath={selectedFile}
                diff={diff}
                diffLoading={diffLoading}
                status={selectedStatus ?? undefined}
                options={diffOptions}
                t={t}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: tone === "error" ? "#f87171" : "var(--text-dim)",
        fontSize: 12,
        padding: 16,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

interface DiffBodyProps {
  cwd: string;
  filePath: string;
  diff: GitFileDiffResponse | null;
  diffLoading: boolean;
  status: GitFileStatus | undefined;
  options: FileDiffOptions<undefined>;
  t: ReturnType<typeof useI18n>["t"];
}

interface ReviewTreeProps {
  nodes: TreeNode[];
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  expandedPaths: Set<string>;
  onToggleFolder: (path: string) => void;
}

const INDENT_PX = 12;

function ReviewTree({
  nodes,
  depth,
  selectedFile,
  onSelectFile,
  expandedPaths,
  onToggleFolder,
}: ReviewTreeProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "folder") {
          const isOpen = expandedPaths.has(node.path);
          return (
            <div key={node.path}>
              <button
                type="button"
                onClick={() => onToggleFolder(node.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  width: "100%",
                  paddingLeft: 6 + depth * INDENT_PX,
                  paddingRight: 8,
                  height: 22,
                  cursor: "pointer",
                  background: "transparent",
                  color: "var(--text-muted)",
                  border: "none",
                  borderRadius: 0,
                  textAlign: "left",
                  fontSize: 12,
                  fontWeight: 600,
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--bg-hover)";
                  event.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                  event.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.12s",
                  }}
                >
                  <polyline points="3 2 7 5 3 8" />
                </svg>
                <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
                  <FolderIcon size={13} open={isOpen} />
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {node.name}
                </span>
                <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                  {node.fileCount}
                </span>
              </button>
              {isOpen && (
                <ReviewTree
                  nodes={node.children}
                  depth={depth + 1}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  expandedPaths={expandedPaths}
                  onToggleFolder={onToggleFolder}
                />
              )}
            </div>
          );
        }
        const isSelected = node.path === selectedFile;
        return (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelectFile(node.path)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              paddingLeft: 6 + depth * INDENT_PX + 14,
              paddingRight: 8,
              height: 22,
              cursor: "pointer",
              background: isSelected ? "var(--bg-selected)" : "transparent",
              color: isSelected ? "var(--text)" : "var(--text-muted)",
              border: "none",
              borderRadius: 0,
              textAlign: "left",
              fontSize: 12,
            }}
            onMouseEnter={(event) => {
              if (!isSelected) {
                event.currentTarget.style.background = "var(--bg-hover)";
                event.currentTarget.style.color = "var(--text)";
              }
            }}
            onMouseLeave={(event) => {
              if (!isSelected) {
                event.currentTarget.style.background = "transparent";
                event.currentTarget.style.color = "var(--text-muted)";
              }
            }}
          >
            <GitStatusBadge status={node.status} />
            <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
              {getFileIcon(node.path, 13)}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {node.name}
            </span>
          </button>
        );
      })}
    </>
  );
}

function DiffBody({
  cwd,
  filePath,
  diff,
  diffLoading,
  status,
  options,
  t,
}: DiffBodyProps) {
  if (diffLoading && !diff) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: 12,
        }}
      >
        {t("rightPanel.reviewLoading")}
      </div>
    );
  }
  if (!diff || !diff.supported || !diff.patch) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          color: "var(--text-dim)",
          fontSize: 12,
          padding: 16,
          textAlign: "center",
        }}
      >
        <span>{t("rightPanel.reviewUnsupported")}</span>
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            wordBreak: "break-all",
          }}
        >
          {filePath.replace(cwd + "/", "")}
        </code>
        {status && (
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            ({status.status})
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        // Our wrapper owns the scroll. The pierre <diffs-container> is
        // `display: block` with no built-in height, so it grows to the
        // full diff height; we clip it here and provide the scrollbar.
        // `overflow: auto` is required (not `hidden`) for wheel/trackpad
        // and a visible scrollbar.
        overflow: "auto",
        padding: "8px 12px",
      }}
    >
      <PatchDiff patch={diff.patch} options={options} />
    </div>
  );
}
