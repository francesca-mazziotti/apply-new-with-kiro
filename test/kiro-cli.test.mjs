import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = new URL("../bin/apply-new.mjs", import.meta.url);
const binPath = fileURLToPath(bin);

test("CLI source flags include Kiro and submit re-derives through the shared source mix", () => {
  const source = readFileSync(bin, "utf8");
  assert.match(source, /kiro:\s*\{\s*root:\s*flag\("kiro-root"\),\s*disabled:\s*has\("no-kiro"\)\s*\}/);
  const calls = [...source.matchAll(/readAllSources\(\{\s*claudeRoot:\s*root,\s*sources:\s*sourceFlags\(\)\s*\}\)/g)];
  assert.equal(calls.length, 2, "generation and submit pre-flight must share sourceFlags() exactly");
});

test("CLI reports Kiro sessions from an explicit root", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kiro-cli-status-"));
  const claude = join(cwd, "claude");
  const kiro = join(cwd, "kiro-sessions");
  const cli = join(kiro, "cli");
  const isolatedHome = join(cwd, "home");
  mkdirSync(claude, { recursive: true });
  mkdirSync(cli, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  writeFileSync(join(cli, "fixture.json"), JSON.stringify({ session_id: "fixture", cwd: "C:\\Users\\sample\\work\\acme-app" }));
  writeFileSync(join(cli, "fixture.jsonl"), JSON.stringify({ version: "v1", kind: "Prompt", data: { message_id: "u1", content: [{ kind: "text", data: "build a fictional widget" }], meta: { timestamp: 1_700_000_000 } } }) + "\n");
  try {
    const result = spawnSync(process.execPath, [binPath, "prepare", "--root", claude, "--kiro-root", kiro, "--no-opencode", "--no-codex", "--no-pi", "--no-cursor", "--no-kimi"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, KIRO_HOME: isolatedHome, ANTHROPIC_API_KEY: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /kiro:\s+1 sessions/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
