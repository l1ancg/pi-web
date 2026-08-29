import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("system/tools panels auto-close on outside pointerdown", () => {
  // The auto-close effect fires only when the active panel is system or tools.
  assert.match(
    source,
    /if \(activeTopPanel !== "system" && activeTopPanel !== "tools"\) return;/,
  );
  // Inside the panel does nothing.
  assert.match(
    source,
    /const panel = topPanelRef\.current;\s*if \(panel && path\.includes\(panel\)\) return;/,
  );
  // Inside the header dots dropdown does nothing — the user can re-trigger
  // via the menu item without surprise closure.
  assert.match(
    source,
    /const dotsDropdown = headerMorePanelRef\.current;\s*if \(dotsDropdown && path\.includes\(dotsDropdown\)\) return;/,
  );
  // Otherwise the panel closes.
  assert.match(
    source,
    /setActiveTopPanel\(null\);[\s\S]*?\}, \[activeTopPanel\]\);/,
  );
});

test("Escape closes the system/tools panel", () => {
  assert.match(
    source,
    /if \(event\.key !== "Escape"\) return;[\s\S]*?setActiveTopPanel\(null\);/,
  );
});

test("the top panel container is identified by topPanelRef", () => {
  // The fixed-position container wraps every activeTopPanel branch so the
  // outside-click handler can compare composedPath() to its DOM node.
  assert.match(source, /const topPanelRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /<div\s+ref=\{topPanelRef\}/);
});
