// Kiro adapter: reads only the observed session records below and normalises
// Kiro CLI and Kiro IDE into the shared Apply New session model.
//
// Opened paths (under --kiro-root, KIRO_HOME/sessions, or ~/.kiro/sessions):
//   cli/<session-id>.json and cli/<session-id>.jsonl
//   <workspace-hash>/<session-dir>/session.json and messages.jsonl
// No recursive generic walk is used. Adjacent config, credentials, auth,
// telemetry, logs, history, indexes, workspace artifacts, .env files, and the
// VS Code-style globalStorage/workspaceStorage trees are never opened.
//
// Observed with Kiro CLI 2.22.1: CLI wire v1 uses Prompt,
// AssistantMessage, and ToolResults records with epoch-second prompt times;
// IDE schema 1.0.0/data-model 1 uses ISO timestamps and typed payload events.
// Assistant reasoning is reduced to a character count; tool-result bodies,
// write/edit bodies, diffs, steering documents, system/framework material,
// titles, descriptions, goals, and sub-agent bodies are discarded.
// Credits are not converted into token counts. Capture is structural.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix } from "./claude-code.mjs";
import { fallbackToolName } from "./tool-vocab.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);
const dirs = (p) => {
  if (!existsSync(p)) return [];
  try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
};
const iso = (v) => {
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
  if (!Number.isFinite(v)) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
};

export function defaultKiroRoot() {
  return join(process.env.KIRO_HOME || join(homedir(), ".kiro"), "sessions");
}

const TOOL_MAP = {
  read: "Read", read_file: "Read", readFile: "Read", read_files: "Read", readCode: "Read",
  write: "Write", write_file: "Write", fs_write: "Write", fs_append: "Write",
  edit: "Edit", edit_file: "Edit", str_replace: "Edit", delete_file: "Edit",
  execute: "Bash", execute_cmd: "Bash", execute_bash: "Bash", execute_pwsh: "Bash",
  controlProcess: "Bash", control_process: "Bash", control_pwsh_process: "Bash",
  getProcessOutput: "Bash", get_process_output: "Bash",
  grep: "Grep", grep_search: "Grep", glob: "Glob", file_search: "Glob", list_directory: "Glob", search: "Glob",
  remote_web_search: "WebSearch", web_fetch: "WebFetch",
  task_list: "TodoWrite", taskList: "TodoWrite", todo_list: "TodoWrite", task_update: "TodoWrite", task_status: "TodoWrite", task_get: "TodoWrite",
  invoke_sub_agent: "Task",
};
const mapTool = (name) => TOOL_MAP[name] || fallbackToolName(name || "unknown");
const textLen = (v) => typeof v === "string" ? v.length : Buffer.byteLength(JSON.stringify(v ?? ""));
const firstString = (...xs) => xs.find((x) => typeof x === "string" && x) || "";

function safeToolUse(id, name, args = {}) {
  const path = firstString(args.path, args.file, args.targetFile, args.cwd, args.working_dir, args.operations?.[0]?.path);
  const cmd = firstString(args.command);
  const q = firstString(args.query, args.pattern, args.searchPhrase);
  return {
    id: id || null,
    name: mapTool(name),
    path: path ? toPosix(redactText(path)) : "",
    cmd: cmd ? redactText(cmd.slice(0, 240)) : "",
    q: q ? redactText(q.slice(0, 200)) : "",
  };
}

function makeSession(id, cwd, model = null) {
  const cwdRaw = typeof cwd === "string" ? cwd : "";
  return {
    source: "kiro", sessionId: id, projectLabel: cwdRaw ? `project-${shortHash(cwdRaw)}` : "project-unknown",
    cwdRaw, cwdRedacted: cwdRaw ? toPosix(redactText(cwdRaw)) : "", gitBranch: null,
    cliVersions: [], models: model ? [redactText(String(model))] : [], messages: [], chain: [], firstTs: null, lastTs: null,
  };
}

function emitter(session) {
  let prev = null;
  let n = 0;
  let hits = 0;
  let chars = 0;
  const emit = (role, ts, text, extra = {}) => {
    const raw = typeof text === "string" ? text : "";
    hits += countRedactions(raw);
    const textRedacted = redactText(raw);
    chars += raw.length - textRedacted.length;
    const uuid = extra.uuid || `${session.sessionId}-turn-${++n}`;
    const m = { role, ts, uuid, parentUuid: prev, model: extra.model || null, textRedacted, textLen: raw.length,
      thinkingChars: extra.thinkingChars || 0, signatureChars: extra.signatureChars || 0,
      toolUses: extra.toolUses || [], toolResults: extra.toolResults || [], usage: extra.usage || null };
    prev = uuid;
    session.messages.push(m);
    if (ts && (!session.firstTs || ts < session.firstTs)) session.firstTs = ts;
    if (ts && (!session.lastTs || ts > session.lastTs)) session.lastTs = ts;
    return m;
  };
  return { emit, totals: () => ({ hits, chars }) };
}

function parseJsonl(path) {
  const buf = readFileSync(path);
  const raw = buf.toString("utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const records = [];
  let malformed = 0;
  let live = false;
  lines.forEach((line, i) => {
    try { records.push(JSON.parse(line)); }
    catch {
      malformed++;
      if (i === lines.length - 1) live = true;
    }
  });
  return { buf, lines: lines.length, records, malformed, live };
}

function readCli(root, stats, files) {
  const out = [];
  const cli = join(root, "cli");
  if (!existsSync(cli)) return out;
  let names;
  try { names = readdirSync(cli).filter((n) => n.endsWith(".jsonl")).sort(); } catch { stats.inaccessibleFiles++; return out; }
  for (const name of names) {
    const id = name.slice(0, -6);
    const metaPath = join(cli, `${id}.json`);
    let meta = null;
    if (existsSync(metaPath)) {
      try { const b = readFileSync(metaPath); meta = JSON.parse(b); files.push({ relPath: relative(root, metaPath), sha256: sha256(b), bytes: b.length, lines: 1, malformed: 0 }); }
      catch { stats.malformedFiles++; }
    }
    const session = makeSession(meta?.session_id || id, meta?.cwd, meta?.session_state?.rts_model_state?.model_info?.model_id);
    const e = emitter(session);
    try {
      const path = join(cli, name);
      const parsed = parseJsonl(path);
      stats.malformedLines += parsed.malformed;
      if (parsed.live) stats.liveSessionsSeen++;
      files.push({ relPath: relative(root, path), sha256: sha256(parsed.buf), bytes: parsed.buf.length, lines: parsed.lines, malformed: parsed.malformed });
      for (const r of parsed.records) {
        if (r?.kind === "Prompt") {
          const text = (r.data?.content || []).filter((c) => c?.kind === "text").map((c) => typeof c.data === "string" ? c.data : "").join("\n");
          e.emit("user", iso(r.data?.meta?.timestamp), text, { uuid: r.data?.message_id });
        } else if (r?.kind === "AssistantMessage") {
          let text = "", thinkingChars = 0, signatureChars = 0;
          const toolUses = [];
          for (const c of r.data?.content || []) {
            if (c?.kind === "text") text += typeof c.data === "string" ? c.data : "";
            else if (c?.kind === "thinking") { thinkingChars += textLen(c.data?.text); signatureChars += textLen(c.data?.signature ?? c.data?.redactedContent); }
            else if (c?.kind === "toolUse") toolUses.push(safeToolUse(c.data?.toolUseId, c.data?.name, c.data?.input));
          }
          e.emit("assistant", null, text, { uuid: r.data?.message_id, thinkingChars, signatureChars, toolUses });
        } else if (r?.kind === "ToolResults") {
          const toolResults = [];
          for (const [id2, entry] of Object.entries(r.data?.results || {})) {
            const result = entry?.result || {};
            toolResults.push({ forId: id2, isError: "Error" in result || "Failure" in result, bytes: textLen(result) });
          }
          if (toolResults.length) e.emit("assistant", null, "", { toolResults });
        }
      }
    } catch { stats.inaccessibleFiles++; }
    const totals = e.totals(); stats.redactionHits += totals.hits; stats.redactedChars += totals.chars;
    session.chain = session.messages.map((m) => ({ uuid: m.uuid, parentUuid: m.parentUuid, ts: m.ts }));
    out.push(session);
  }
  return out;
}

function readIde(root, stats, files) {
  const out = [];
  for (const workspace of dirs(root).filter((n) => n !== "cli")) {
    for (const dirname of dirs(join(root, workspace))) {
      const dir = join(root, workspace, dirname);
      const metaPath = join(dir, "session.json");
      const logPath = join(dir, "messages.jsonl");
      if (!existsSync(metaPath) && !existsSync(logPath)) continue;
      let meta = null;
      if (existsSync(metaPath)) {
        try { const b = readFileSync(metaPath); meta = JSON.parse(b); files.push({ relPath: relative(root, metaPath), sha256: sha256(b), bytes: b.length, lines: 1, malformed: 0 }); }
        catch { stats.malformedFiles++; }
      }
      const cwd = meta?.workspacePaths?.[0] || meta?.rootPaths?.[0] || "";
      const session = makeSession(meta?.id || (dirname.startsWith("sess_") ? dirname.slice(5) : dirname), cwd, meta?.modelId);
      const e = emitter(session);
      let current = null;
      if (existsSync(logPath)) try {
        const parsed = parseJsonl(logPath);
        stats.malformedLines += parsed.malformed;
        if (parsed.live) stats.liveSessionsSeen++;
        files.push({ relPath: relative(root, logPath), sha256: sha256(parsed.buf), bytes: parsed.buf.length, lines: parsed.lines, malformed: parsed.malformed });
        for (const r of parsed.records) {
          const p = r?.payload || {};
          const ts = iso(r?.timestamp);
          if (p.type === "user") {
            const text = typeof p.content === "string" ? p.content : "";
            if (!text || text.startsWith("Execute hook:")) continue;
            current = e.emit("user", ts, text, { uuid: r.id });
          } else if (p.type === "assistant") {
            if (p.operationType === "Reasoning") {
              if (!current || current.role !== "assistant") current = e.emit("assistant", ts, "", { uuid: r.id });
              current.thinkingChars += textLen(p.content);
              current.signatureChars += textLen(p.reasoningSignature);
              const model = p.reasoningModelId && redactText(p.reasoningModelId);
              if (model && !session.models.includes(model)) session.models.push(model);
            } else {
              current = e.emit("assistant", ts, typeof p.content === "string" ? p.content : "", { uuid: r.id });
            }
          } else if (p.type === "tool_call") {
            if (!current || current.role !== "assistant") current = e.emit("assistant", ts, "", { uuid: r.id });
            current.toolUses.push(safeToolUse(p.toolCallId, p.toolName, p.args));
          } else if (p.type === "tool_result") {
            if (!current || current.role !== "assistant") current = e.emit("assistant", ts, "", { uuid: r.id });
            current.toolResults.push({ forId: p.toolCallId || null, isError: p.success === false || !!p.errorMessage, bytes: textLen(p.content ?? p.value) });
          } else if (p.type === "sub_agent_start") {
            if (!current || current.role !== "assistant") current = e.emit("assistant", ts, "", { uuid: r.id });
            current.toolUses.push({ id: p.subSessionId || r.id, name: "Task", path: "", cmd: "", q: "" });
          } else if (p.type === "sub_agent_complete") {
            if (!current || current.role !== "assistant") current = e.emit("assistant", ts, "", { uuid: r.id });
            current.toolResults.push({ forId: p.subSessionId || null, isError: p.status === "error", bytes: textLen(p.response) });
          }
        }
      } catch { stats.inaccessibleFiles++; }
      const totals = e.totals(); stats.redactionHits += totals.hits; stats.redactedChars += totals.chars;
      session.chain = session.messages.map((m) => ({ uuid: m.uuid, parentUuid: m.parentUuid, ts: m.ts }));
      out.push(session);
    }
  }
  return out;
}

const EMPTY = (root) => ({ source: "kiro", root: root || null, files: [], sessions: [], compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 }, stats: { cliSessions: 0, ideSessions: 0, duplicateSessions: 0, malformedLines: 0, malformedFiles: 0, inaccessibleFiles: 0, liveSessionsSeen: 0 } });

export function readKiro(root = defaultKiroRoot()) {
  if (!root || !existsSync(root)) return EMPTY(root);
  const files = [];
  const stats = { cliSessions: 0, ideSessions: 0, duplicateSessions: 0, malformedLines: 0, malformedFiles: 0, inaccessibleFiles: 0, liveSessionsSeen: 0, redactionHits: 0, redactedChars: 0 };
  const cli = readCli(root, stats, files);
  const ide = readIde(root, stats, files);
  stats.cliSessions = cli.length;
  stats.ideSessions = ide.length;
  const byId = new Map();
  for (const s of [...cli, ...ide]) {
    const old = byId.get(s.sessionId);
    if (!old || s.messages.length > old.messages.length) byId.set(s.sessionId, s);
    if (old) stats.duplicateSessions++;
  }
  const { redactionHits, redactedChars, ...publicStats } = stats;
  return { source: "kiro", root, files, sessions: [...byId.values()], compactionSummaries: [], redaction: { hits: redactionHits, charsRemoved: redactedChars }, stats: publicStats };
}
