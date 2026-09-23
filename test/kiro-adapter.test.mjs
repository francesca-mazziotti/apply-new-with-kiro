import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readKiro, defaultKiroRoot } from "../src/adapters/kiro.mjs";
import { buildDigest } from "../src/digest.mjs";
import { readAllSources } from "../src/sources.mjs";

const makeRoot = () => mkdtempSync(join(tmpdir(), "kiro-adapter-"));
const jsonl = (path, rows, trailing = true) => writeFileSync(path, rows.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + (trailing ? "\n" : ""));

function cliFixture(root, id = "same-id") {
  const dir = join(root, "cli"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ session_id: id, cwd: "C:\\Users\\alice\\work\\app", title: "SECRET TITLE", session_state: { goal: "SECRET GOAL", rts_model_state: { model_info: { model_id: "auto" } } } }));
  jsonl(join(dir, `${id}.jsonl`), [
    { version: "v1", kind: "Prompt", data: { message_id: "u1", content: [{ kind: "text", data: "email alice@example.com" }], meta: { timestamp: 1_700_000_000 } } },
    { version: "v1", kind: "AssistantMessage", data: { message_id: "a1", content: [
      { kind: "thinking", data: { text: "PRIVATE REASONING", redactedContent: "OPAQUE SIGNATURE", modelId: "auto" } },
      { kind: "text", data: "done" },
      { kind: "toolUse", data: { toolUseId: "t1", name: "write", input: { path: "C:\\Users\\alice\\work\\app\\x.js", content: "FORBIDDEN FILE BODY" } } },
      { kind: "toolUse", data: { toolUseId: "t2", name: "execute_cmd", input: { command: "npm test" } } },
    ] } },
    { version: "v1", kind: "ToolResults", data: { results: { t1: { tool: {}, result: { Success: { items: [{ Text: "FORBIDDEN TOOL OUTPUT" }] } } } } } },
    "{truncated",
  ], false);
}

function ideFixture(root, id = "ide-id", dirname = `sess_${id}`) {
  const dir = join(root, "abcdef0123456789", dirname); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, schemaVersion: "1.0.0", dataModelVersion: 1, workspacePaths: ["C:\\Users\\alice\\work\\ide"], modelId: "auto", title: "PRIVATE TITLE", description: "PRIVATE SUMMARY" }));
  jsonl(join(dir, "messages.jsonl"), [
    { id: "hook", timestamp: "2026-08-01T10:00:00Z", payload: { type: "user", source: "chat", content: "Execute hook: injected framework content" } },
    { id: "u2", timestamp: "2026-08-01T10:00:01Z", payload: { type: "user", content: "contact bob@example.com", documents: [{ content: "PRIVATE STEERING" }] } },
    { id: "r2", timestamp: "2026-08-01T10:00:02Z", payload: { type: "assistant", operationType: "Reasoning", content: "PRIVATE IDE REASONING", reasoningSignature: "PRIVATE SIGNATURE", reasoningModelId: "qdev::auto" } },
    { id: "a2", timestamp: "2026-08-01T10:00:03Z", payload: { type: "assistant", operationType: "Say", content: "answer" } },
    { id: "tc", timestamp: "2026-08-01T10:00:04Z", payload: { type: "tool_call", toolCallId: "x", toolName: "str_replace", args: { path: "C:\\Users\\alice\\work\\ide\\a.ts", oldStr: "OLD SECRET", newStr: "NEW SECRET" } } },
    { id: "tr", timestamp: "2026-08-01T10:00:05Z", payload: { type: "tool_result", toolCallId: "x", success: false, content: "PRIVATE RESULT" } },
    { id: "sa", timestamp: "2026-08-01T10:00:06Z", payload: { type: "sub_agent_start", subSessionId: "child", prompt: "PRIVATE DELEGATION PROMPT" } },
    { id: "sd", timestamp: "2026-08-01T10:00:07Z", payload: { type: "sub_agent_complete", subSessionId: "child", response: "PRIVATE DELEGATION RESPONSE", status: "success" } },
    { id: "usage", timestamp: "2026-08-01T10:00:08Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", usage: 0.5 }] } },
  ]);
}

test("reads observed CLI v1 and IDE 1.0.0 formats into one structural source", () => {
  const root = makeRoot();
  try {
    cliFixture(root); ideFixture(root); ideFixture(root, "old-id", "old-id");
    const parsed = readKiro(root);
    assert.equal(parsed.source, "kiro");
    assert.equal(parsed.sessions.length, 3);
    assert.equal(parsed.stats.cliSessions, 1);
    assert.equal(parsed.stats.ideSessions, 2);
    const cli = parsed.sessions.find((s) => s.sessionId === "same-id");
    assert.equal(cli.firstTs, "2023-11-14T22:13:20.000Z");
    assert.equal(cli.cwdRedacted.includes("alice"), false);
    assert.deepEqual(cli.messages.flatMap((m) => m.toolUses).map((u) => u.name), ["Write", "Bash"]);
    const ide = parsed.sessions.find((s) => s.sessionId === "ide-id");
    assert.equal(ide.messages.filter((m) => m.role === "user").length, 1);
    assert.ok(ide.messages.some((m) => m.thinkingChars > 0));
    assert.ok(ide.messages.flatMap((m) => m.toolUses).some((u) => u.name === "Edit"));
    assert.ok(ide.messages.flatMap((m) => m.toolUses).some((u) => u.name === "Task"));
    assert.equal(ide.messages.flatMap((m) => m.toolResults).find((r) => r.forId === "x").isError, true);
    assert.ok(ide.messages.every((m) => m.usage === null));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("privacy serialization drops bodies, reasoning, metadata, framework text, and PII", () => {
  const root = makeRoot();
  try {
    cliFixture(root); ideFixture(root);
    const serialized = JSON.stringify(readKiro(root));
    for (const forbidden of ["SECRET TITLE", "SECRET GOAL", "FORBIDDEN FILE BODY", "FORBIDDEN TOOL OUTPUT", "PRIVATE REASONING", "PRIVATE TITLE", "PRIVATE SUMMARY", "PRIVATE STEERING", "PRIVATE IDE REASONING", "PRIVATE SIGNATURE", "OLD SECRET", "NEW SECRET", "PRIVATE RESULT", "PRIVATE DELEGATION PROMPT", "PRIVATE DELEGATION RESPONSE", "Execute hook:", "alice@example.com", "bob@example.com"]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed trailing records count as malformed and live", () => {
  const root = makeRoot();
  try { cliFixture(root); const p = readKiro(root); assert.equal(p.stats.malformedLines, 1); assert.equal(p.stats.liveSessionsSeen, 1); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed earlier record followed by valid unterminated final record is not live", () => {
  const root = makeRoot();
  try {
    cliFixture(root);
    jsonl(join(root, "cli", "same-id.jsonl"), ["{malformed-earlier", { version: "v1", kind: "Prompt", data: { message_id: "u-final", content: [{ kind: "text", data: "valid final" }], meta: { timestamp: 1_700_000_001 } } }], false);
    const p = readKiro(root);
    assert.equal(p.stats.malformedLines, 1);
    assert.equal(p.stats.liveSessionsSeen, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("valid unterminated final record is neither malformed nor live", () => {
  const root = makeRoot();
  try {
    cliFixture(root);
    jsonl(join(root, "cli", "same-id.jsonl"), [{ version: "v1", kind: "Prompt", data: { message_id: "u-final", content: [{ kind: "text", data: "valid final" }], meta: { timestamp: 1_700_000_001 } } }], false);
    const p = readKiro(root);
    assert.equal(p.stats.malformedLines, 0);
    assert.equal(p.stats.liveSessionsSeen, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing root is an empty bundle", () => {
  assert.equal(readKiro(join(tmpdir(), `missing-kiro-${Date.now()}`)).sessions.length, 0);
});

test("malformed metadata and missing companion files degrade through stats", () => {
  const root = makeRoot();
  try {
    const cli = join(root, "cli"); mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "bad.json"), "{");
    jsonl(join(cli, "bad.jsonl"), []);
    const ide = join(root, "workspace", "sess_missing"); mkdirSync(ide, { recursive: true });
    writeFileSync(join(ide, "session.json"), JSON.stringify({ id: "missing" }));
    const p = readKiro(root);
    assert.equal(p.stats.malformedFiles, 1);
    assert.equal(p.sessions.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable-id duplicates prefer richer messages and use discovery order for ties", () => {
  const root = makeRoot();
  try { cliFixture(root, "dup"); ideFixture(root, "dup"); const p = readKiro(root); assert.equal(p.sessions.length, 1); assert.equal(p.stats.duplicateSessions, 1); assert.equal(p.sessions[0].cwdRaw, "C:\\Users\\alice\\work\\app"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("buildDigest consumes Kiro sessions unchanged", () => {
  const root = makeRoot();
  try { ideFixture(root); const d = buildDigest(readKiro(root)); assert.equal(d.projectCount, 1); assert.equal(d.projects[0].orchestration.tools.kiro, 1); assert.equal(d.projects[0].delegation, 1); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("KIRO_HOME controls the default sessions root", () => {
  const old = process.env.KIRO_HOME;
  process.env.KIRO_HOME = "C:\\isolated-kiro-home";
  try { assert.equal(defaultKiroRoot(), join("C:\\isolated-kiro-home", "sessions")); }
  finally { if (old === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = old; }
});

test("readAllSources honors the Kiro root override and opt-out", () => {
  const root = makeRoot(); const claudeRoot = makeRoot();
  try {
    cliFixture(root);
    const otherDisabled = { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } };
    const included = readAllSources({ claudeRoot, sources: { ...otherDisabled, kiro: { root, disabled: false } } });
    assert.equal(included.sessions[0].source, "kiro");
    const excluded = readAllSources({ claudeRoot, sources: { ...otherDisabled, kiro: { root, disabled: true } } });
    assert.equal(excluded.sessions.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(claudeRoot, { recursive: true, force: true }); }
});

test("readAllSources treats an absent Kiro source key as default-on", () => {
  const home = makeRoot(); const claudeRoot = makeRoot();
  const old = process.env.KIRO_HOME;
  try {
    const root = join(home, "sessions"); mkdirSync(root, { recursive: true }); cliFixture(root);
    process.env.KIRO_HOME = home;
    const parsed = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } } });
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].source, "kiro");
  } finally {
    if (old === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = old;
    rmSync(home, { recursive: true, force: true }); rmSync(claudeRoot, { recursive: true, force: true });
  }
});
