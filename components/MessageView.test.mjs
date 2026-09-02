import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

const LONG_COMPACTION_SUMMARY = [
  "## Goal",
  "Refactor the auth flow to use refresh tokens instead of long-lived sessions.",
  "Steps:",
  "- Replace session cookies with `__Host-refresh` cookie",
  "- Add a server-side `/auth/refresh` handler that issues 15-minute access tokens",
  "- Migrate the login page to set the new cookie and drop the old one",
  "## Files of interest",
  "- app/api/auth/login/route.ts",
  "- app/api/auth/refresh/route.ts",
  "- lib/session.ts",
  "<read-files>",
  "app/api/auth/login/route.ts",
  "lib/session.ts",
  "</read-files>",
  "<modified-files>",
  "app/api/auth/refresh/route.ts",
  "lib/session.ts",
  "</modified-files>",
].join("\n");

function renderCompaction(summary, custom = {}) {
  return renderMessage({
    role: "custom",
    customType: "compaction",
    display: true,
    content: summary,
    timestamp: Date.parse("2026-05-07T12:34:56.000Z"),
    ...custom,
  });
}

test("renders compaction card collapsed by default and shows only the header row", () => {
  const html = renderCompaction(LONG_COMPACTION_SUMMARY);

  // Header is the toggle and reports collapsed.
  assert.match(html, /<button[^>]+aria-expanded="false"[^>]*>/);
  assert.match(html, /aria-label="Show compaction details"/);

  // Title text and badge are visible in the collapsed state.
  assert.match(html, />compaction</);
  assert.match(html, />Conversation compacted</);

  // Char + line counts help users gauge size without opening the card.
  assert.match(html, />\d+ · \d+ lines?</);

  // Summary body, preview, description and file metadata are hidden until expanded.
  assert.doesNotMatch(html, /Refactor the auth flow to use refresh tokens/);
  assert.doesNotMatch(html, /The conversation history before this point was compacted/);
  assert.doesNotMatch(html, /File context/);
  assert.doesNotMatch(html, /Read files/);
  assert.doesNotMatch(html, /Modified files/);
});

test("keeps the entire compaction card collapsed even for short summaries", () => {
  const html = renderCompaction("Short recap: shipped the fix.");

  assert.match(html, /<button[^>]+aria-expanded="false"[^>]*>/);
  // Short summary body does not leak into the collapsed view either.
  assert.doesNotMatch(html, /Short recap: shipped the fix\./);
  assert.doesNotMatch(html, /The conversation history before this point was compacted/);
});

test("omits the file-metadata details when the compaction has no file sections", () => {
  const html = renderCompaction("Plain summary without any file lists.");

  assert.match(html, /<button[^>]+aria-expanded="false"[^>]*>/);
  assert.doesNotMatch(html, /compaction-file-details/);
  assert.doesNotMatch(html, /File context/);
});

test("renders no preview body when the compaction summary is empty", () => {
  const html = renderCompaction("\n\n   \n");

  assert.match(html, /<button[^>]+aria-expanded="false"[^>]*>/);
  assert.match(html, />Conversation compacted</);
  // The summary body remains hidden when collapsed.
  assert.doesNotMatch(html, /Refactor the auth flow/);
});
