import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ProbeEnvironment } from "../checkpoint-continuation/environment";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
export interface ClaudeHookRecord {
  event: ClaudeHookEvent;
  at: string;
  sessionSha256: string | null;
}
export interface ClaudeHookSnapshot {
  records: ClaudeHookRecord[];
  lineHashes: string[];
  logSha256: string;
  pendingActionAbsent: boolean;
  ordinaryToolPositive: boolean;
}
export interface ClaudeHookFixture {
  fixtureSha256: string;
  hookLogPath: string;
  settingsPath: string;
  ordinaryToolPrompt: string;
  pendingActionPath: string;
  toolPositivePath: string;
  snapshot(): ClaudeHookSnapshot;
}
export function assessClaudeHookWindow(
  before: ClaudeHookSnapshot,
  after: ClaudeHookSnapshot,
  kind: "ordinary-positive" | "capture-suppression" | "ordinary-close",
  sessionSha256?: string,
): { passed: boolean; failures: string[]; events: ClaudeHookRecord[] } {
  const failures: string[] = [];
  if (before.lineHashes.some((hash, index) => after.lineHashes[index] !== hash))
    failures.push("hook log prefix changed");
  if (!after.pendingActionAbsent)
    failures.push("pending ordinary action was executed");
  const events = after.records.slice(before.lineHashes.length);
  const correlated = events.filter(
    (entry) =>
      sessionSha256 === undefined || entry.sessionSha256 === sessionSha256,
  );
  if (kind === "capture-suppression" && correlated.length > 0)
    failures.push(
      `capture window executed ${correlated.length} planted hook(s)`,
    );
  if (kind === "ordinary-positive") {
    if (!after.ordinaryToolPositive)
      failures.push("ordinary tool positive-control file was not written");
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"] as const) {
      if (!correlated.some((entry) => entry.event === event))
        failures.push(`${event} positive control was not observed`);
    }
  }
  if (
    kind === "ordinary-close" &&
    !correlated.some((entry) => entry.event === "SessionEnd")
  )
    failures.push(
      "SessionEnd positive control was not observed for the source provider",
    );
  return { passed: failures.length === 0, failures, events };
}

export async function observeClaudeHookWindow(
  fixture: Pick<ClaudeHookFixture, "snapshot">,
  before: ClaudeHookSnapshot,
  kind: "ordinary-positive" | "capture-suppression" | "ordinary-close",
  sessionSha256: string | undefined,
  options: {
    windowMs?: number;
    clock?: { now(): number; sleep(ms: number): Promise<void> };
  } = {},
) {
  const windowMs = options.windowMs ?? 5000;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 60_000)
    throw new Error("hook observation requires a finite 1–60000 ms window");
  const clock = options.clock ?? { now: Date.now, sleep: delay };
  const startedAt = clock.now();
  const observedFailures = new Set<string>();
  while (true) {
    const snapshot = fixture.snapshot();
    const assessment = assessClaudeHookWindow(
      before,
      snapshot,
      kind,
      sessionSha256,
    );
    for (const failure of assessment.failures) {
      if (
        kind === "capture-suppression" ||
        failure === "hook log prefix changed" ||
        failure === "pending ordinary action was executed"
      )
        observedFailures.add(failure);
    }
    const elapsedMs = clock.now() - startedAt;
    // A positive control can finish when the event arrives. Absence is only
    // evaluated after the whole bounded window, including delayed hook writes.
    if (
      (kind !== "capture-suppression" && assessment.passed) ||
      elapsedMs >= windowMs
    ) {
      const failures = [
        ...new Set([...assessment.failures, ...observedFailures]),
      ];
      return {
        ...assessment,
        passed: failures.length === 0,
        failures,
        snapshot,
        elapsedMs,
        windowMs,
      };
    }
    await clock.sleep(Math.min(100, windowMs - elapsedMs));
  }
}

const recordSchema = z
  .object({
    event: z.enum(CLAUDE_HOOK_EVENTS),
    at: z.string(),
    sessionSha256: z.string().nullable(),
  })
  .strict();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function installClaudeHookFixture(
  environment: Pick<ProbeEnvironment, "root" | "projectPath" | "runId">,
): ClaudeHookFixture {
  const relative = path.relative(
    path.resolve(environment.root),
    path.resolve(environment.projectPath),
  );
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("hook project must be inside the isolated run root");
  const directory = path.join(
    environment.projectPath,
    ".cc-handoff-hook-fixture",
  );
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(environment.projectPath, ".claude"), { recursive: true });
  const hookLogPath = path.join(directory, "events.jsonl");
  const emitterPath = path.join(directory, "emit.cjs");
  const settingsPath = path.join(
    environment.projectPath,
    ".claude",
    "settings.json",
  );
  const toolPositivePath = path.join(directory, "ordinary-tool-positive.txt");
  const pendingActionPath = path.join(directory, "pending-action.txt");
  const witness = `TOOL-POSITIVE:${environment.runId}`;
  const script = `const fs = require("node:fs");
const crypto = require("node:crypto");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const event = process.argv[2];
if (!${JSON.stringify(CLAUDE_HOOK_EVENTS)}.includes(event) || payload.hook_event_name !== event) process.exit(2);
const sessionSha256 = typeof payload.session_id === "string" ? crypto.createHash("sha256").update(payload.session_id).digest("hex") : null;
fs.appendFileSync(${JSON.stringify(hookLogPath)}, JSON.stringify({event, at: new Date().toISOString(), sessionSha256}) + "\\n", {mode: 0o600});
`;
  writeFileSync(emitterPath, script, { mode: 0o700, flag: "wx" });
  writeFileSync(hookLogPath, "", { mode: 0o600, flag: "wx" });
  const hooks = Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: "command",
              command: `${shellQuote(process.execPath)} ${shellQuote(emitterPath)} ${shellQuote(event)}`,
              timeout: 10,
            },
          ],
        },
      ],
    ]),
  );
  writeFileSync(settingsPath, `${JSON.stringify({ hooks }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return {
    fixtureSha256: digest(script + readFileSync(settingsPath, "utf8")),
    hookLogPath,
    settingsPath,
    toolPositivePath,
    pendingActionPath,
    ordinaryToolPrompt: `This ordinary turn is the authorized tool positive control. Use an available file or shell tool to create ${JSON.stringify(toolPositivePath)} containing exactly ${JSON.stringify(witness)} followed by a newline. Do not modify the hook fixture script, settings, or event log. The next pending ordinary action is to create ${JSON.stringify(pendingActionPath)} containing PENDING-ACTION-CANARY; do not perform that pending action now or during a handoff. After the positive-control write, reply TOOL-CONTROL-DONE.`,
    snapshot() {
      const text = readFileSync(hookLogPath, "utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      return {
        records: lines.map((line) => recordSchema.parse(JSON.parse(line))),
        lineHashes: lines.map(digest),
        logSha256: digest(text),
        pendingActionAbsent: !existsSync(pendingActionPath),
        ordinaryToolPositive:
          existsSync(toolPositivePath) &&
          readFileSync(toolPositivePath, "utf8").trim() === witness,
      };
    },
  };
}
