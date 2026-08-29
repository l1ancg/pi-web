export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

// Inner file-tree column inside the right panel. Width is constrained by the
// outer right-panel width so tree + viewer always fit the panel.
export const RIGHT_PANEL_TREE_FALLBACK_WIDTH = 260;
export const RIGHT_PANEL_TREE_MIN_WIDTH = 200;
export const RIGHT_PANEL_TREE_MAX_WIDTH = 600;
export const RIGHT_PANEL_TREE_MIN_VIEWER_WIDTH = 240;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 420;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - DESKTOP_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}

export function getRightPanelTreeMaxWidth(options: {
  viewportWidth: number;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_TREE_MAX_WIDTH;
  const maxByViewer = Math.max(
    RIGHT_PANEL_TREE_MIN_WIDTH,
    rightPanelWidth - RIGHT_PANEL_TREE_MIN_VIEWER_WIDTH,
  );
  return Math.min(RIGHT_PANEL_TREE_MAX_WIDTH, maxByViewer);
}

export function getDefaultRightPanelTreeWidth(options: {
  viewportWidth: number;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelWidth } = options;
  // 40% of the right panel gives the tree a comfortable share without
  // squeezing the viewer below its minimum.
  const maxWidth = getRightPanelTreeMaxWidth(options);
  const candidate = rightPanelWidth * 0.4;
  if (viewportWidth === 0) return RIGHT_PANEL_TREE_FALLBACK_WIDTH;
  void viewportWidth; // reserved for future responsive tuning
  return clampPanelWidth(candidate, RIGHT_PANEL_TREE_MIN_WIDTH, maxWidth);
}
