import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileViewerBlock() {
  const start = source.indexOf("{/* Right side: file viewer");
  assert.notEqual(start, -1, "file viewer block comment not found");
  // Find the matching </div> for the right-panel-files-viewer container by
  // searching for the unique empty-state div that follows the FileViewer
  // ternary.
  const endMarker = 'files.noneOpen")}';
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "file viewer empty state not found");
  // Walk forward to the closing </div> of the right-panel-files-viewer.
  const close = source.indexOf("</div>", end);
  assert.notEqual(close, -1, "file viewer block close not found");
  return source.slice(start, close + "</div>".length);
}

test("only mounts the FileViewer when an active file is open", () => {
  const block = fileViewerBlock();
  assert.match(block, /\{openFile \? \(/);
  assert.match(block, /<FileViewer/);
  assert.match(block, /\{translate\("files\.noneOpen"\)\}/);
});

test("the viewer is keyed by file path and viewer revision and restores its state", () => {
  const block = fileViewerBlock();
  assert.match(block, /key=\{`\$\{openFile\.filePath\}:\$\{openFile\.viewerRevision\}`\}/);
  assert.match(block, /initialState=\{openFile\.viewerState\}/);
});

test("viewer state changes flow through a single AppShell handler", () => {
  assert.match(source, /handleFileViewerStateChange = useCallback\(\(viewerState: FileViewerState\) => \{/);
  assert.match(source, /setOpenFile\(\(prev\) => \(prev \? \{ \.\.\.prev, viewerState \} : prev\)\)/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(fileViewerBlock(), /watchEnabled=\{rightPanelOpen\}/);
});

test("handleOpenFile bumps the viewer revision so a new file remounts the viewer", () => {
  assert.match(
    source,
    /viewerRevision: \(prev\?\.viewerRevision \?\? 0\) \+ 1/,
  );
});

test("handleOpenFile preserves viewer state only when the same file is reopened", () => {
  assert.match(
    source,
    /viewerState: modeHint \?[\s\S]*?: prev\?\.filePath === filePath[\s\S]*?: undefined/,
  );
});

test("switching to a different project clears the open file and closes the panel", () => {
  assert.match(source, /setOpenFile\(null\);/);
  assert.match(source, /setRightPanelOpen\(false\);/);
});
