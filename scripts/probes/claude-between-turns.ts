/**
 * C5b probes (docs/design/2026-10-12-claude-between-turns-c5b.md §9): how the
 * installed Claude CLI behaves around background work, continuations and
 * input sent while it works. Drives the SDK the way the adapter does (one
 * persistent input channel, bypassed permissions, stamped uuids) and records
 * every frame with its arrival time. Spends real credit; operator-run only.
 *
 *   scripts/probes/run-claude-between-turns.sh [--model haiku] [--scenario <name>]
 *
 * Scenarios: continuation, handover, live-input, crossing-input,
 * task-ends-in-turn, lifetime-close, lifetime-sigterm, lifetime-sigkill.
 * Evidence goes to .cc/temp/c5b-probes/<run>/<scenario>.jsonl, with a summary
 * per scenario. A scenario whose required frame never arrives is recorded as
 * failed, and the run exits non-zero.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Scenario =
  | "continuation"
  | "handover"
  | "live-input"
  | "crossing-input"
  | "task-ends-in-turn"
  | "staggered-tasks"
  | "lifetime-close"
  | "lifetime-sigterm"
  | "lifetime-sigkill";

const ALL_SCENARIOS: Scenario[] = [
  "continuation",
  "handover",
  "live-input",
  "crossing-input",
  "task-ends-in-turn",
  "staggered-tasks",
  "lifetime-close",
  "lifetime-sigterm",
  "lifetime-sigkill",
];

interface Recorded {
  t: number;
  type: string;
  subtype?: string;
  fields: Record<string, unknown>;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A persistent input channel, as the adapter keeps one per runtime. */
function inputChannel() {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }
  return {
    messages,
    send(text: string): string {
      const uuid = randomUUID();
      pending.push({
        type: "user",
        session_id: "",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        uuid,
      } as SDKUserMessage);
      wake?.();
      return uuid;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

const KEPT_FIELDS = [
  "uuid",
  "user_message_uuid",
  "user_message_uuids",
  "queued_turn_count",
  "origin",
  "num_turns",
  "result_index",
  "is_error",
  "total_cost_usd",
  "task_id",
  "status",
  // What the adapter classifies tasks by.
  "patch",
  "is_backgrounded",
  "ambient",
  "skip_transcript",
  "task_type",
  "state",
  "tasks",
  "tool_use_id",
  "session_id",
  "stop_reason",
  "terminal_reason",
];

function record(start: number, message: SDKMessage): Recorded {
  const raw = message as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of KEPT_FIELDS) if (key in raw) fields[key] = raw[key];
  if (message.type === "assistant") {
    const content = (raw.message as { content?: unknown[] } | undefined)
      ?.content;
    fields.content = (content ?? []).map((block) => {
      const b = block as Record<string, unknown>;
      return b.type === "text"
        ? { type: "text", text: String(b.text).slice(0, 200) }
        : b.type === "tool_use"
          ? { type: "tool_use", name: b.name, input: b.input }
          : { type: b.type };
    });
  }
  // Not in the SDK's public types: keep every field.
  if ((message.type as string) === "command_lifecycle")
    for (const [key, value] of Object.entries(raw)) fields[key] = value;
  if (message.type === "result" && "result" in raw)
    fields.result = String(raw.result).slice(0, 200);
  return {
    t: Date.now() - start,
    type: message.type,
    ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
    fields,
  };
}

interface Session {
  frames: Recorded[];
  send(text: string): string;
  close(): void;
  /** Resolves with the first frame (arriving after now) that matches. */
  until(
    match: (frame: Recorded) => boolean,
    timeoutMs: number,
  ): Promise<Recorded | null>;
  done: Promise<void>;
}

/** Sessions a failed scenario leaves open; the runner closes them. */
const openSessions = new Set<Session>();

function startSession(options: {
  model: string;
  cwd: string;
  log: string;
}): Session {
  const start = Date.now();
  const channel = inputChannel();
  const frames: Recorded[] = [];
  const waiters: Array<{
    match: (frame: Recorded) => boolean;
    resolve: (frame: Recorded | null) => void;
  }> = [];
  const q = query({
    prompt: channel.messages(),
    options: {
      cwd: options.cwd,
      model: options.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      persistSession: true,
      env: {
        ...process.env,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      } as Record<string, string>,
    },
  });
  const done = (async () => {
    try {
      for await (const message of q) {
        const frame = record(start, message);
        frames.push(frame);
        appendFileSync(options.log, `${JSON.stringify(frame)}\n`);
        for (const waiter of [...waiters]) {
          if (!waiter.match(frame)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    } catch (error) {
      appendFileSync(
        options.log,
        `${JSON.stringify({ t: Date.now() - start, type: "pump_error", fields: { error: String(error) } })}\n`,
      );
    } finally {
      for (const waiter of waiters.splice(0)) waiter.resolve(null);
    }
  })();
  const session: Session = {
    frames,
    send: (text) => {
      const uuid = channel.send(text);
      appendFileSync(
        options.log,
        `${JSON.stringify({ t: Date.now() - start, type: "sent", fields: { uuid, text } })}\n`,
      );
      return uuid;
    },
    close: () => {
      openSessions.delete(session);
      channel.close();
      q.close();
    },
    until: (match, timeoutMs) =>
      new Promise((resolve) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
      }),
    done,
  };
  openSessions.add(session);
  return session;
}

class ScenarioFailed extends Error {}

/** A frame the scenario cannot go on without; its absence fails the scenario. */
async function required(
  wait: Promise<Recorded | null>,
  what: string,
): Promise<Recorded> {
  const frame = await wait;
  if (frame === null) throw new ScenarioFailed(`no ${what} arrived in time`);
  return frame;
}

const isResult = (frame: Recorded) => frame.type === "result";
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed"]);
/** The first frame that ends a task: a terminal `task_updated` patch or the notification. */
const isTaskEnd = (frame: Recorded) => {
  if (frame.subtype === "task_notification") return true;
  if (frame.subtype !== "task_updated") return false;
  const patch = frame.fields.patch;
  const status: unknown =
    typeof patch === "object" && patch !== null
      ? Reflect.get(patch, "status")
      : undefined;
  return typeof status === "string" && TERMINAL_TASK_STATUSES.has(status);
};

const BACKGROUND = (command: string) =>
  `Use the Bash tool with run_in_background set to true to run exactly this command: \`${command}\`. Do not wait for it and do not check on it. Then reply with only the word STARTED and end your turn.`;

async function continuation(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(BACKGROUND("sleep 12; echo done > bg.txt"));
  await required(s.until(isResult, 120_000), "result for the first turn");
  // The continuation, if any, arrives as further frames and a result.
  await s.until(isResult, 120_000);
  await sleep(5_000);
  s.close();
  await s.done;
}

async function handover(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(BACKGROUND("sleep 10; echo done > bg.txt"));
  await required(s.until(isResult, 120_000), "result for the first turn");
  // Send a person's prompt the moment the task ends, racing the continuation.
  await required(s.until(isTaskEnd, 120_000), "end of the background task");
  s.send("Reply with only the word BANANA.");
  await required(s.until(isResult, 120_000), "result after the prompt");
  // A second result only if the CLI ran the prompt as a turn of its own.
  await s.until(isResult, 60_000);
  await sleep(5_000);
  s.close();
  await s.done;
}

async function liveInput(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(
    "Use the Bash tool to run `sleep 8` in the foreground and wait for it, then reply with only the word DONE.",
  );
  await required(
    s.until((f) => f.type === "assistant", 60_000),
    "first assistant frame",
  );
  await sleep(1_500);
  s.send("Also reply with the word APPLE.");
  await sleep(300);
  s.send("And the word CHERRY.");
  await required(s.until(isResult, 120_000), "result for the turn");
  // A second result only if the CLI ran the live inputs as a turn of their own.
  await s.until(isResult, 30_000);
  await sleep(5_000);
  s.close();
  await s.done;
}

async function crossingInput(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send("Reply with only the word ONE.");
  // Send the next input in the same tick as the first result arrives.
  await required(s.until(isResult, 60_000), "result for ONE");
  s.send("Reply with only the word TWO.");
  await required(s.until(isResult, 60_000), "result for TWO");
  await sleep(5_000);
  s.close();
  await s.done;
}

/** A background task that ends while the same turn still runs a foreground command. */
async function taskEndsInTurn(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(
    "First use the Bash tool with run_in_background set to true to run exactly `sleep 4; echo done > bg.txt`. Then, without checking on it, use the Bash tool in the foreground to run exactly `sleep 12`. Then reply with only the word DONE and end your turn.",
  );
  await required(s.until(isResult, 120_000), "result for the turn");
  // A continuation for the background task, if the CLI runs one after the result.
  await s.until(isResult, 30_000);
  await sleep(5_000);
  s.close();
  await s.done;
}

/** Two background tasks whose ends straddle the first one's continuation. */
async function staggeredTasks(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(
    "Use the Bash tool with run_in_background set to true twice: first to run exactly `sleep 6; echo a > a.txt`, then to run exactly `sleep 10; echo b > b.txt`. Do not wait for either and do not check on them. Then reply with only the word STARTED and end your turn.",
  );
  await required(s.until(isResult, 120_000), "result for the first turn");
  // Record every continuation until the CLI stays quiet for 15 s.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await s.until(isResult, 15_000)) === null) break;
  }
  s.close();
  await s.done;
}

const TICKER = "while true; do date +%s >> ticks.txt; sleep 0.5; done";

/** Kills tickers that outlived their CLI; whether any existed is evidence. */
function reapTickers(log: string): void {
  const reaped = spawnSync("pkill", ["-f", "date \\+%s >> ticks.txt"]);
  appendFileSync(
    log,
    `${JSON.stringify({ type: "reap", fields: { survivorsKilled: reaped.status === 0 } })}\n`,
  );
}

function ticks(dir: string): number {
  const file = path.join(dir, "ticks.txt");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").length : 0;
}

async function lifetimeClose(model: string, dir: string, log: string) {
  const s = startSession({ model, cwd: dir, log });
  s.send(BACKGROUND(TICKER));
  await required(s.until(isResult, 120_000), "result starting the ticker");
  await sleep(2_000);
  const before = ticks(dir);
  s.close();
  await s.done;
  await sleep(1_500);
  const atClose = ticks(dir);
  await sleep(5_000);
  const after = ticks(dir);
  appendFileSync(
    log,
    `${JSON.stringify({ type: "lifetime", fields: { before, atClose, after, growingAfterClose: after > atClose } })}\n`,
  );
  reapTickers(log);
}

/** The CLI's parent (the "server") is killed with `signal` while the ticker runs. */
async function lifetimeSignal(
  model: string,
  dir: string,
  log: string,
  signal: "SIGTERM" | "SIGKILL",
) {
  const child = spawn(
    process.execPath,
    [
      process.argv[1] ?? "",
      "--role",
      "child",
      "--model",
      model,
      "--dir",
      dir,
      "--log",
      log,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const started = await new Promise<boolean>((resolve) => {
    child.stdout.on("data", (data: Buffer) => {
      if (data.toString().includes("CHILD_STARTED")) resolve(true);
    });
    child.once("exit", () => resolve(false));
  });
  if (!started) throw new ScenarioFailed("the child never started its ticker");
  await sleep(2_000);
  const before = ticks(dir);
  const killedAt = Date.now();
  child.kill(signal);
  await new Promise((r) => child.once("exit", r));
  // Sample the writer until it has been still for 3 s, up to 30 s.
  const samples: Array<{ ms: number; ticks: number }> = [];
  let lastGrowth = Date.now();
  let last = ticks(dir);
  while (Date.now() - killedAt < 30_000 && Date.now() - lastGrowth < 3_000) {
    await sleep(250);
    const now = ticks(dir);
    if (now > last) lastGrowth = Date.now();
    last = now;
    samples.push({ ms: Date.now() - killedAt, ticks: now });
  }
  appendFileSync(
    log,
    `${JSON.stringify({ type: "lifetime", fields: { signal, before, lastWriteAfterKillMs: lastGrowth - killedAt, samples } })}\n`,
  );
  reapTickers(log);
}

async function childRole() {
  const model = flag("--model") ?? "haiku";
  const dir = flag("--dir") ?? ".";
  const log = flag("--log") ?? "/dev/null";
  const s = startSession({ model, cwd: dir, log });
  s.send(BACKGROUND(TICKER));
  await required(s.until(isResult, 120_000), "result starting the ticker");
  process.stdout.write("CHILD_STARTED\n");
  await new Promise(() => undefined);
}

async function main() {
  if (flag("--role") === "child") return childRole();
  const model = flag("--model") ?? "haiku";
  const only = flag("--scenario");
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.resolve(".cc/temp/c5b-probes", run);
  mkdirSync(root, { recursive: true });
  const scenarios = ALL_SCENARIOS.filter(
    (s) => only === undefined || s === only,
  );
  for (const scenario of scenarios) {
    const dir = path.join(root, scenario);
    mkdirSync(dir, { recursive: true });
    const log = path.join(root, `${scenario}.jsonl`);
    writeFileSync(log, "");
    process.stdout.write(`${scenario}…\n`);
    const runners: Record<Scenario, () => Promise<void>> = {
      continuation: () => continuation(model, dir, log),
      handover: () => handover(model, dir, log),
      "live-input": () => liveInput(model, dir, log),
      "crossing-input": () => crossingInput(model, dir, log),
      "task-ends-in-turn": () => taskEndsInTurn(model, dir, log),
      "staggered-tasks": () => staggeredTasks(model, dir, log),
      "lifetime-close": () => lifetimeClose(model, dir, log),
      "lifetime-sigterm": () => lifetimeSignal(model, dir, log, "SIGTERM"),
      "lifetime-sigkill": () => lifetimeSignal(model, dir, log, "SIGKILL"),
    };
    try {
      await runners[scenario]();
    } catch (error) {
      if (!(error instanceof ScenarioFailed)) throw error;
      appendFileSync(
        log,
        `${JSON.stringify({ type: "scenario_failed", fields: { reason: error.message } })}\n`,
      );
      process.stdout.write(`  FAILED: ${error.message}\n`);
      process.exitCode = 1;
      for (const open of [...openSessions]) {
        open.close();
        await open.done;
      }
    }
    process.stdout.write(`  ${statSync(log).size} bytes -> ${log}\n`);
  }
  process.stdout.write(`evidence: ${root}\n`);
}

await main();
