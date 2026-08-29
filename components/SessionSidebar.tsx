"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies, type SessionFamily } from "@/lib/session-family";
import { getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const EXPANDED_PROJECTS_STORAGE_KEY = "pi-web:expanded-projects";
const RECENT_EXPANDED_STORAGE_KEY = "pi-web:recent-expanded";
const RUNNING_SESSIONS_POLL_MS = 2500;

const SECTION_HEADER_HEIGHT = 28;
const ROW_HEIGHT = 30;
const SUBROW_INDENT = 22;

// ──────────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────────

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === "string"));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

function loadExpandedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((k): k is string => typeof k === "string"));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function saveExpandedProjects(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(EXPANDED_PROJECTS_STORAGE_KEY);
    else window.localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function loadRecentExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(RECENT_EXPANDED_STORAGE_KEY);
    return raw !== "0";
  } catch {
    return true;
  }
}

function saveRecentExpanded(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_EXPANDED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
}

function isDefaultCwd(cwd: string | null | undefined, homeDir: string): boolean {
  if (!cwd || !homeDir) return false;
  if (cwd === homeDir) return false;
  return cwd.startsWith(`${homeDir}/pi-cwd-`);
}

function getFileName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}


// ──────────────────────────────────────────────────────────────────────────────
// Scramble animation for the title (Pi Web <-> version string)
// ──────────────────────────────────────────────────────────────────────────────

const SCRAMBLE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join(""),
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion
    ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}`
    : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(
    () => () => {
      if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    },
    [],
  );

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "default",
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
        textAlign: "left",
      }}
    >
      {display}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Activity indicators
// ──────────────────────────────────────────────────────────────────────────────

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

function ActivityCounts({
  activity,
}: {
  activity: { running: number; unread: number } | undefined;
}) {
  const { t } = useI18n();
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        marginLeft: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      }}
    >
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 2, color: "var(--accent)" }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 2, color: "#0891b2" }}
        >
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Action button (hover-revealed by CSS)
// ──────────────────────────────────────────────────────────────────────────────

interface ActionButtonProps {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  ariaLabel: string;
  color?: string;
  hoverColor?: string;
  disabled?: boolean;
  size?: number;
  children: ReactNode;
}

function ActionButton({
  onClick,
  title,
  ariaLabel,
  color = "var(--text-dim)",
  hoverColor = "var(--text)",
  disabled = false,
  size = 22,
  children,
}: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick(e);
      }}
      onMouseEnter={() => !disabled && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        padding: 0,
        flexShrink: 0,
        background: "transparent",
        border: "none",
        borderRadius: 0,
        pointerEvents: "auto",
        color: hovered ? hoverColor : color,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "color 0.12s",
      }}
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Confirm delete overlay
// ──────────────────────────────────────────────────────────────────────────────

interface ConfirmTarget {
  kind: "session" | "project";
  id: string;
  title: string;
  detail?: string;
}

function ConfirmOverlay({
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  target: ConfirmTarget;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--bg) 60%, transparent)",
        backdropFilter: "blur(2px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(280px, 92%)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 14,
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {target.kind === "project"
            ? t("sidebar.confirmDeleteProject")
            : t("sidebar.confirmDeleteSession", { title: target.title })}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          }}
        >
          {target.title}
          {target.detail && (
            <>
              <br />
              <span style={{ color: "var(--text-dim)" }}>{target.detail}</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "5px 12px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {t("sidebar.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "5px 12px",
              background: "#ef4444",
              border: "1px solid #ef4444",
              borderRadius: 6,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {t("sidebar.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Session row
// ──────────────────────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: SessionInfo;
  depth: number;
  isSelected: boolean;
  isRunning: boolean;
  isUnread: boolean;
  pendingDeleteKind: "session" | "project" | null;
  onClick: () => void;
  onAskDelete: () => void;
}

function SessionRow({
  session,
  depth,
  isSelected,
  isRunning,
  isUnread,
  pendingDeleteKind,
  onClick,
  onAskDelete,
}: SessionRowProps) {
  const { locale, t } = useI18n();

  const displayFirstMessage =
    skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title =
    session.name || displayFirstMessage.slice(0, 60) || session.id.slice(0, 12);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="piweb-sidebar-row"
      data-active={isSelected ? "true" : undefined}
      title={title}
      style={{
        height: ROW_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10 + depth * SUBROW_INDENT,
        paddingRight: 6,
        cursor: "pointer",
        color: isSelected ? "var(--text)" : "var(--text)",
      }}
    >
      {depth > 0 ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          <rect x="5" y="7" width="14" height="11" rx="2" />
          <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
        </svg>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}

      {isRunning ? (
        <RunningSessionIndicator />
      ) : isUnread ? (
        <UnreadSessionIndicator />
      ) : null}

      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12,
          fontWeight: isSelected ? 500 : 400,
        }}
      >
        {title}
      </span>

      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          display: "inline-flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        <span title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
        <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
      </span>

      <span className="piweb-sidebar-actions">
        <ActionButton
          onClick={onAskDelete}
          title={t("sidebar.deleteWithShiftClick")}
          ariaLabel={t("sidebar.delete")}
          hoverColor="#ef4444"
          disabled={pendingDeleteKind !== null}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </ActionButton>
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Project item (collapsible)
// ──────────────────────────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: { key: string; root: string };
  families: SessionFamily[];
  expanded: boolean;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  activity: { running: number; unread: number } | undefined;
  pendingDeleteKind: "session" | "project" | null;
  homeDir: string;
  onToggle: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: (cwd: string) => void;
  onAskDeleteProject: () => void;
  onAskDeleteSession: (session: SessionInfo) => void;
}

function ProjectItem({
  project,
  families,
  expanded,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  activity,
  pendingDeleteKind,
  homeDir,
  onToggle,
  onSelectSession,
  onNewSession,
  onAskDeleteProject,
  onAskDeleteSession,
}: ProjectItemProps) {
  const { t } = useI18n();
  const hasChildren = families.length > 0;
  const isActive = families.some(
    (family) =>
      family.root.id === selectedSessionId ||
      family.subagents.some((s) => s.id === selectedSessionId),
  );

  const display = displayCwd(project.root, homeDir);
  const projectName = getFileName(project.root) || project.root;
  const subtitle = display === `~/${projectName}` ? "" : display;

  return (
    <div className="piweb-sidebar-group">
      <div
        className="piweb-sidebar-row piweb-sidebar-row--plain"
        style={{
          height: ROW_HEIGHT,
          display: "flex",
          alignItems: "center",
          gap: 5,
          paddingLeft: 8,
          paddingRight: 6,
          color: "var(--text)",
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          title={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            background: "transparent",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.15s",
          }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>

        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke={isActive ? "var(--accent)" : "var(--text-muted)"}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, pointerEvents: "none" }}
          aria-hidden="true"
        >
          <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1 1.2h6A1 1 0 0 1 13.5 5.7v6.3a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z" />
        </svg>

        <div
          role="button"
          tabIndex={0}
          aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          title={project.root}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            userSelect: "none",
            borderRadius: 4,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
            }}
          >
            {projectName}
          </span>
          {subtitle && (
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 10,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                minWidth: 0,
                flex: 1,
                direction: "rtl",
                textAlign: "left",
              }}
            >
              <span style={{ unicodeBidi: "plaintext" }}>{subtitle}</span>
            </span>
          )}
        </div>

        <ActivityCounts activity={activity} />

        <span
          className="piweb-sidebar-actions"
          onClick={(event) => event.stopPropagation()}
          style={{ pointerEvents: "none" }}
        >
          <ActionButton
            onClick={() => onNewSession(project.root)}
            title={t("sidebar.newSessionInFolder", { path: project.root })}
            ariaLabel={t("sidebar.newSessionInFolder", { path: project.root })}
            hoverColor="var(--accent)"
            disabled={pendingDeleteKind !== null}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
            </svg>
          </ActionButton>
          <ActionButton
            onClick={onAskDeleteProject}
            title={t("sidebar.delete")}
            ariaLabel={t("sidebar.delete")}
            hoverColor="#ef4444"
            disabled={pendingDeleteKind !== null || !hasChildren}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </ActionButton>
        </span>
      </div>

      {expanded && hasChildren && (
        <div>
          {families.map((family) => {
            const displaySession =
              family.latestModified === family.root.modified
                ? family.root
                : { ...family.root, modified: family.latestModified };
            return (
              <div key={family.root.id}>
                <SessionRow
                  session={displaySession}
                  depth={0}
                  isSelected={
                    selectedSessionId === family.root.id ||
                    family.subagents.some((s) => s.id === selectedSessionId)
                  }
                  isRunning={
                    runningSessionIds.has(family.root.id) ||
                    family.subagents.some((s) => runningSessionIds.has(s.id))
                  }
                  isUnread={
                    unreadSessionIds.has(family.root.id) ||
                    family.subagents.some((s) => unreadSessionIds.has(s.id))
                  }
                  pendingDeleteKind={pendingDeleteKind}
                  onClick={() => onSelectSession(family.root)}
                  onAskDelete={() => onAskDeleteSession(family.root)}
                />
                {family.subagents.map((sub) => (
                  <SessionRow
                    key={sub.id}
                    session={sub}
                    depth={1}
                    isSelected={selectedSessionId === sub.id}
                    isRunning={runningSessionIds.has(sub.id)}
                    isUnread={unreadSessionIds.has(sub.id)}
                    pendingDeleteKind={pendingDeleteKind}
                    onClick={() => onSelectSession(sub)}
                    onAskDelete={() => onAskDeleteSession(sub)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Section header
// ──────────────────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  expanded,
  onToggle,
  onAdd,
  pendingDelete,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  pendingDelete: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="piweb-sidebar-row"
      style={{
        height: SECTION_HEADER_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 6px 4px 8px",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
          flexShrink: 0,
          transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform 0.15s",
        }}
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      <span
        role="button"
        tabIndex={0}
        aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {title}
      </span>
      {onAdd && (
        <span
          className="piweb-sidebar-actions"
          onClick={(event) => event.stopPropagation()}
          style={{ pointerEvents: "none" }}
        >
          <ActionButton
            onClick={onAdd}
            title={t("sidebar.addProject")}
            ariaLabel={t("sidebar.addProject")}
            hoverColor="var(--accent)"
            disabled={pendingDelete}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </ActionButton>
        </span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────

export function SessionSidebar({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  initialSessionId,
  skipInitialProjectSelection,
  onInitialRestoreDone,
  refreshKey,
  onSessionDeleted,
  selectedCwd: selectedCwdProp,
  onCwdChange,
  onBackgroundTaskDone,
  onRunningSessionIdsChange,
  onSessionsChange,
}: Props) {
  const { t } = useI18n();

  // ── Data state ─────────────────────────────────────────────────────────────
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const runningPollAuthoritativeRef = useRef(false);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Directory picker (for + on Projects header) ────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  // ── Confirm delete ────────────────────────────────────────────────────────
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // ──────────────────────────────────────────────────────────────────────────
  // Load sessions
  // ──────────────────────────────────────────────────────────────────────────
  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        sessions: SessionInfo[];
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      setAllSessions(data.sessions);
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  useEffect(() => {
    saveRecentExpanded(recentExpanded);
  }, [recentExpanded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setExpandedProjects(loadExpandedProjects());
    setRecentExpanded(loadRecentExpanded());
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Running sessions poll
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        /* keep last known state */
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter(
      (id) => !runningSessionIds.has(id) && id !== selectedSessionId,
    );
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) =>
        !previousSuppressedCompletionSessionIdsRef.current.has(id) &&
        !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      void loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) =>
          currentSuppressedCompletionSessionIdsRef.current.has(id) ||
          knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home")
      .then((r) => r.json())
      .then((d: { home?: string }) => {
        if (d.home) setHomeDir(d.home);
      })
      .catch(() => {});
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Sync selectedCwd from prop (driven by AppShell's selected session)
  // ──────────────────────────────────────────────────────────────────────────
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // ──────────────────────────────────────────────────────────────────────────
  // Notify parent of cwd changes (with project identity hydration)
  // ──────────────────────────────────────────────────────────────────────────
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    const match = allSessions.find((s) => s.cwd === selectedCwd);
    const projectRoot = match?.projectRoot ?? selectedCwd;
    const projectKey = match ? workspaceKeyOf(match) : (selectedCwd ?? "");
    onCwdChange?.(selectedCwd, projectRoot, projectKey || null);
  }, [selectedCwd, allSessions, onCwdChange]);

  // ──────────────────────────────────────────────────────────────────────────
  // Initial restore from ?session= URL
  // ──────────────────────────────────────────────────────────────────────────
  const restoredRef = useRef(false);
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        // Auto-expand the project containing this session
        const key = workspaceKeyOf(target);
        if (!isDefaultCwd(target.cwd, homeDir)) {
          setExpandedProjects((prev) => {
            if (prev.has(key)) return prev;
            const next = new Set(prev);
            next.add(key);
            return next;
          });
        }
        return;
      }
      onInitialRestoreDone?.();
    }
  }, [
    allSessions,
    initialSessionId,
    skipInitialProjectSelection,
    onSelectSession,
    onInitialRestoreDone,
    homeDir,
  ]);

  // ──────────────────────────────────────────────────────────────────────────
  // Auto-expand the project containing selectedSessionId whenever it changes
  // ──────────────────────────────────────────────────────────────────────────
  const lastAutoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSessionId) return;
    if (lastAutoExpandedRef.current === selectedSessionId) return;
    lastAutoExpandedRef.current = selectedSessionId;
    const target = allSessions.find((s) => s.id === selectedSessionId);
    if (!target) return;
    if (isDefaultCwd(target.cwd, homeDir)) return;
    const key = workspaceKeyOf(target);
    setExpandedProjects((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [selectedSessionId, allSessions, homeDir]);

  // ──────────────────────────────────────────────────────────────────────────
  // Derived data: projects and recent sessions
  // ──────────────────────────────────────────────────────────────────────────
  const projects = useMemo(() => {
    return getRecentProjects(allSessions).filter((p) => !isDefaultCwd(p.root, homeDir));
  }, [allSessions, homeDir]);

  const recentSessions = useMemo(() => {
    return allSessions.filter((s) => isDefaultCwd(s.cwd, homeDir));
  }, [allSessions, homeDir]);

  const projectActivity = useMemo(() => {
    const counts = new Map<string, { running: number; unread: number }>();
    for (const session of allSessions) {
      if (isDefaultCwd(session.cwd, homeDir)) continue;
      const key = workspaceKeyOf(session);
      let entry = counts.get(key);
      if (!entry) {
        entry = { running: 0, unread: 0 };
        counts.set(key, entry);
      }
      if (runningSessionIds.has(session.id)) entry.running++;
      if (unreadSessionIds.has(session.id)) entry.unread++;
    }
    return counts;
  }, [allSessions, runningSessionIds, unreadSessionIds, homeDir]);

  // ──────────────────────────────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────────────────────────────
  const newTempId = useCallback(() => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }, []);

  const handleNewSessionInCwd = useCallback(
    (cwd: string) => {
      if (!cwd) return;
      onNewSession?.(newTempId(), cwd);
    },
    [onNewSession, newTempId],
  );

  const handleSelectSession = useCallback(
    (session: SessionInfo) => {
      if (session.cwd) setSelectedCwd(session.cwd);
      onSelectSession(session);
    },
    [onSelectSession],
  );

  const toggleProject = useCallback((key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handlePickerSelect = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed || pickerBusy) return;
      setPickerBusy(true);
      setPickerError(null);
      try {
        const res = await fetch("/api/cwd/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: trimmed }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          cwd?: string;
          projectRoot?: string;
          projectKey?: string;
          error?: string;
        };
        if (!res.ok || data.error || !data.cwd) {
          setPickerError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        const validated = data.cwd;
        // If this folder already has sessions (matches an existing project or
        // matches the recent cwd), skip — user is told via a brief error.
        const existsAsProject = allSessions.some((s) => {
          if (isDefaultCwd(s.cwd, homeDir)) return false;
          return (s.projectRoot ?? s.cwd) === (data.projectRoot ?? validated);
        });
        const existsAsRecent = allSessions.some((s) => s.cwd === validated);
        if (existsAsProject || existsAsRecent) {
          setPickerError(t("sidebar.folderAlreadyExists"));
          // Auto-dismiss after a moment so the user can retry
          setTimeout(() => {
            setPickerOpen(false);
            setPickerError(null);
          }, 900);
          return;
        }

        setPickerOpen(false);
        setSelectedCwd(validated);
        handleNewSessionInCwd(validated);
      } catch (e) {
        setPickerError(e instanceof Error ? e.message : String(e));
      } finally {
        setPickerBusy(false);
      }
    },
    [allSessions, homeDir, pickerBusy, t, handleNewSessionInCwd],
  );

  const handleNewInRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = (await res.json()) as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        handleNewSessionInCwd(data.cwd);
      }
    } catch {
      /* ignore */
    }
  }, [handleNewSessionInCwd]);

  const performDeleteSession = useCallback(
    async (session: SessionInfo) => {
      setDeleteBusy(true);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onSessionDeleted?.(session.id);
        setConfirmTarget(null);
        await loadSessions(false, true);
      } catch (e) {
        setConfirmTarget(null);
        setError(String(e));
      } finally {
        setDeleteBusy(false);
      }
    },
    [loadSessions, onSessionDeleted],
  );

  const performDeleteProject = useCallback(
    async (projectKey: string) => {
      setDeleteBusy(true);
      try {
        const sessions = sessionsForProject(allSessions, projectKey);
        for (const session of sessions) {
          await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
            method: "DELETE",
          });
          onSessionDeleted?.(session.id);
        }
        // Drop the project from expanded set
        setExpandedProjects((prev) => {
          if (!prev.has(projectKey)) return prev;
          const next = new Set(prev);
          next.delete(projectKey);
          return next;
        });
        setConfirmTarget(null);
        await loadSessions(false, true);
      } catch (e) {
        setConfirmTarget(null);
        setError(String(e));
      } finally {
        setDeleteBusy(false);
      }
    },
    [allSessions, loadSessions, onSessionDeleted],
  );

  const handleConfirm = useCallback(() => {
    if (!confirmTarget) return;
    if (confirmTarget.kind === "session") {
      const session = allSessions.find((s) => s.id === confirmTarget.id);
      if (session) void performDeleteSession(session);
    } else {
      void performDeleteProject(confirmTarget.id);
    }
  }, [confirmTarget, allSessions, performDeleteSession, performDeleteProject]);

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────
  const pendingDeleteKind = confirmTarget?.kind ?? null;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      {pickerOpen && (
        <DirectoryPicker
          initialPath=""
          busy={pickerBusy}
          error={pickerError}
          onCancel={() => {
            setPickerOpen(false);
            setPickerError(null);
          }}
          onSelect={handlePickerSelect}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "10px 10px 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <PiWebTitle />
        <button
          type="button"
          onClick={() => void loadSessions(false, true)}
          title={t("sidebar.refresh")}
          aria-label={t("sidebar.refresh")}
          className="piweb-sidebar-row"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "transparent",
            border: "none",
            borderRadius: 5,
            color: sessionRefreshDone ? "#4ade80" : "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
            transition: "background 0.3s, color 0.3s",
          }}
        >
          {sessionRefreshDone ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </button>
      </div>

      {/* ── Scrollable region: Projects + Recent ──────────────────────── */}
      <div
        className="piweb-sidebar-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* Projects section */}
        <SectionHeader
          title={t("sidebar.projects")}
          expanded={projectsExpanded}
          onToggle={() => setProjectsExpanded((v) => !v)}
          onAdd={() => {
            setPickerError(null);
            setPickerOpen(true);
          }}
          pendingDelete={pendingDeleteKind !== null}
        />

        {projectsExpanded && (
          <div>
            {loading && (
              <div style={{ padding: "6px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                {t("sidebar.loading")}
              </div>
            )}
            {error && (
              <div style={{ padding: "6px 14px", color: "#f87171", fontSize: 12 }}>
                {error}
              </div>
            )}
            {!loading && !error && projects.length === 0 && (
              <div style={{ padding: "6px 14px", color: "var(--text-dim)", fontSize: 11 }}>
                {t("sidebar.emptyProjects")}
              </div>
            )}
            {projects.map((project) => {
              const sessions = sessionsForProject(allSessions, project.key);
              const families = listSessionFamilies(sessions);
              return (
                <ProjectItem
                  key={project.key}
                  project={project}
                  families={families}
                  expanded={expandedProjects.has(project.key)}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  activity={projectActivity.get(project.key)}
                  pendingDeleteKind={pendingDeleteKind}
                  homeDir={homeDir}
                  onToggle={() => toggleProject(project.key)}
                  onSelectSession={handleSelectSession}
                  onNewSession={handleNewSessionInCwd}
                  onAskDeleteProject={() => {
                    const count = sessions.filter((s) => s.relation?.kind !== "subagent").length;
                    setConfirmTarget({
                      kind: "project",
                      id: project.key,
                      title: project.root,
                      detail:
                        count > 0
                          ? t("sidebar.deleteProjectDetail", { count })
                          : t("sidebar.deleteProjectEmpty"),
                    });
                  }}
                  onAskDeleteSession={(session) => {
                    const displayFirstMessage =
                      skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
                    const title =
                      session.name ||
                      displayFirstMessage.slice(0, 50) ||
                      session.id.slice(0, 12);
                    setConfirmTarget({
                      kind: "session",
                      id: session.id,
                      title,
                    });
                  }}
                />
              );
            })}
          </div>
        )}

        {/* Recent section */}
        {recentSessions.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <SectionHeader
            title={t("sidebar.recent")}
            expanded={recentExpanded}
            onToggle={() => setRecentExpanded((v) => !v)}
            onAdd={handleNewInRecent}
            pendingDelete={pendingDeleteKind !== null}
          />

          {recentExpanded && (
            <div>
              {(() => {
                const families = listSessionFamilies(recentSessions);
                return families.map((family) => {
                  const displaySession =
                    family.latestModified === family.root.modified
                      ? family.root
                      : { ...family.root, modified: family.latestModified };
                  return (
                    <div key={family.root.id}>
                      <SessionRow
                        session={displaySession}
                        depth={0}
                        isSelected={
                          selectedSessionId === family.root.id ||
                          family.subagents.some((s) => s.id === selectedSessionId)
                        }
                        isRunning={
                          runningSessionIds.has(family.root.id) ||
                          family.subagents.some((s) => runningSessionIds.has(s.id))
                        }
                        isUnread={
                          unreadSessionIds.has(family.root.id) ||
                          family.subagents.some((s) => unreadSessionIds.has(s.id))
                        }
                        pendingDeleteKind={pendingDeleteKind}
                        onClick={() => handleSelectSession(family.root)}
                        onAskDelete={() => {
                          const s = family.root;
                          const displayFirstMessage =
                            skillExpansionToCommand(s.firstMessage) ?? s.firstMessage;
                          const title =
                            s.name ||
                            displayFirstMessage.slice(0, 50) ||
                            s.id.slice(0, 12);
                          setConfirmTarget({ kind: "session", id: s.id, title });
                        }}
                      />
                      {family.subagents.map((sub) => (
                        <SessionRow
                          key={sub.id}
                          session={sub}
                          depth={1}
                          isSelected={selectedSessionId === sub.id}
                          isRunning={runningSessionIds.has(sub.id)}
                          isUnread={unreadSessionIds.has(sub.id)}
                          pendingDeleteKind={pendingDeleteKind}
                          onClick={() => handleSelectSession(sub)}
                          onAskDelete={() => {
                            const displayFirstMessage =
                              skillExpansionToCommand(sub.firstMessage) ?? sub.firstMessage;
                            const title =
                              sub.name ||
                              displayFirstMessage.slice(0, 50) ||
                              sub.id.slice(0, 12);
                            setConfirmTarget({ kind: "session", id: sub.id, title });
                          }}
                        />
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
        )}
      </div>

      {/* ── Confirm overlay ───────────────────────────────────────────── */}
      {confirmTarget && (
        <ConfirmOverlay
          target={confirmTarget}
          busy={deleteBusy}
          onConfirm={handleConfirm}
          onCancel={() => !deleteBusy && setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
