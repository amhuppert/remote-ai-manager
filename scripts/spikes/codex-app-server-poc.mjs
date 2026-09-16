#!/usr/bin/env node
// Research harness: real Codex calls, isolated state, no CC production imports.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  mkdir,
  copyFile,
  chmod,
  writeFile,
  appendFile,
  readFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { Codex } from "@openai/codex-sdk";

const require = createRequire(import.meta.url);
const root = process.cwd();
const execFileAsync = promisify(execFile);
if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/spikes/codex-app-server-poc.mjs [--scenario steer|compat|cancel|burst|instructions|policy|image|lost-ack|crash|mcp|eof-active|instruction-recovery|parent-lifecycle|parent-kill-escalation|compaction|all] [--model MODEL] [--out .cc/temp/NEW_DIRECTORY]\nUses real model calls and scratch Codex state. Copies auth.json privately and removes that copy on normal/error completion. Raw research evidence stays in the output directory.",
  );
  process.exit(0);
}
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const scenario = flag("scenario", "steer");
const model = flag("model", "gpt-5.6-sol");
const runDir = path.resolve(
  flag("out", `.cc/temp/codex-app-server-poc/${Date.now()}`),
);
assert(
  runDir.startsWith(path.join(root, ".cc", "temp") + path.sep),
  "Output must be worktree-local .cc/temp",
);
assert(
  !existsSync(runDir),
  "Choose a new output directory; evidence is never appended to an earlier run",
);
const codexHome = path.join(runDir, "codex-home");
const workspace = path.join(runDir, "workspace");
const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
const platformPackage = require.resolve(
  `@openai/codex-${process.platform}-${process.arch}/package.json`,
);
const binary = path.join(
  path.dirname(platformPackage),
  "vendor",
  target,
  "bin",
  "codex",
);
const config = {
  memories: {
    dedicated_tools: false,
    generate_memories: false,
    use_memories: false,
  },
  web_search: "disabled",
  project_doc_max_bytes: 0,
  skills: { bundled: { enabled: false }, include_instructions: false },
  apps: { _default: { enabled: false } },
  include_apps_instructions: false,
  model_reasoning_effort: "low",
};
const env = { ...process.env, CODEX_HOME: codexHome };
for (const key of Object.keys(env)) {
  if (
    key.startsWith("CC_") ||
    [
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ].includes(key)
  )
    delete env[key];
}
const clients = new Set();
const probeProcesses = new Map();
const checks = [];
const started = Date.now();
const marker = (label) => `${label}_${randomUUID().slice(0, 8)}`;
const text = (value) => [{ type: "text", text: value }];
const check = (name, details = {}) => {
  checks.push({ name, ...details });
  console.log(`PASS ${name} ${JSON.stringify(details)}`);
};

class RpcClient {
  constructor(label, parentFixture = false) {
    this.label = label;
    this.frames = [];
    this.pending = new Map();
    this.nextId = 0;
    this.dropResponses = new Set();
    this.waiters = new Set();
    this.stderr = "";
    this.started = Date.now();
    this.logWrites = Promise.resolve();
    this.parentEvents = [];
    this.child = spawn(
      parentFixture ? process.execPath : binary,
      parentFixture
        ? [
            path.join(
              root,
              "scripts/spikes/codex-app-server-parent-fixture.mjs",
            ),
            binary,
          ]
        : ["app-server", "--listen", "stdio://"],
      {
        cwd: workspace,
        env:
          parentFixture === "ignore-term"
            ? { ...env, POC_APP_IGNORE_TERM: "1" }
            : env,
        stdio: parentFixture
          ? ["pipe", "pipe", "pipe", "ipc"]
          : ["pipe", "pipe", "pipe"],
      },
    );
    this.child.on("message", (message) => {
      this.parentEvents.push(message);
      this.record("parent", message);
    });
    clients.add(this);
    this.closed = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.exit = { code, signal };
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error(`process closed: ${code}/${signal}`));
        }
        this.pending.clear();
        for (const wake of this.waiters) wake();
        resolve(this.exit);
      }),
    );
    this.child.on("error", (error) => {
      this.processError = error;
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.processError = error;
          continue;
        }
        this.record("received", message);
        if (Object.hasOwn(message, "id") && !message.method) {
          if (this.dropResponses.has(message.id)) {
            this.record("fault", { droppedResponseId: message.id });
            continue;
          }
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
              pending.reject(
                Object.assign(new Error(message.error.message), {
                  rpcError: message.error,
                }),
              );
            else pending.resolve(message.result);
          }
        } else if (Object.hasOwn(message, "id") && message.method) {
          // Unexpected requests must not hang this probe or silently grant permissions.
          if (message.method === "mcpServer/elicitation/request")
            this.send({
              id: message.id,
              result: { action: "decline", content: null },
            });
          else
            this.send({
              id: message.id,
              error: {
                code: -32601,
                message: "Research client does not implement this request",
              },
            });
        }
        for (const wake of this.waiters) wake();
      }
    });
  }
  record(direction, message) {
    const frame = {
      sequence: this.frames.length,
      elapsedMs: Date.now() - this.started,
      direction,
      message,
    };
    this.frames.push(frame);
    this.logWrites = this.logWrites.then(() =>
      appendFile(
        path.join(runDir, `${this.label}.jsonl`),
        JSON.stringify(frame) + "\n",
      ),
    );
  }
  send(message) {
    this.record("sent", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params, timeoutMs = 30_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async wait(predicate, from = 0, timeoutMs = 120_000) {
    const find = () =>
      this.frames
        .slice(from)
        .find(
          (frame) => frame.direction === "received" && predicate(frame.message),
        );
    const found = find();
    if (found) return found;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      const wake = () => {
        const frame = find();
        if (frame) {
          cleanup();
          resolve(frame);
        } else if (this.exit || this.processError) {
          cleanup();
          reject(
            this.processError ??
              new Error("process exited before expected event"),
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `event timed out (${this.label}); recent methods: ${this.frames
              .slice(-8)
              .map((f) => f.message.method)
              .join(",")}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }
  async initialize() {
    this.initialized = await this.request("initialize", {
      clientInfo: { name: "cc_appserver_poc", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
  }
  async thread(threadId, extra = {}) {
    const params = {
      model,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config,
      ...extra,
    };
    const result = await this.request(
      threadId ? "thread/resume" : "thread/start",
      threadId ? { ...params, threadId } : params,
    );
    return result.thread.id;
  }
  async turn(threadId, prompt) {
    const from = this.frames.length;
    const result = await this.request("turn/start", {
      threadId,
      input: text(prompt),
      effort: "low",
    });
    return { id: result.turn.id, from };
  }
  async completed(turn) {
    const frame = await this.wait(
      (m) => m.method === "turn/completed" && m.params.turn.id === turn.id,
      turn.from,
    );
    const frames = this.frames.slice(turn.from, frame.sequence + 1);
    const messages = frames
      .filter(
        (f) =>
          f.direction === "received" &&
          f.message.method === "item/completed" &&
          f.message.params.item.type === "agentMessage",
      )
      .map((f) => f.message.params.item);
    return {
      status: frame.message.params.turn.status,
      turn: frame.message.params.turn,
      messages,
      final:
        messages
          .filter((m) => m.phase === "final_answer")
          .map((m) => m.text)
          .join("\n") ||
        messages.at(-1)?.text ||
        "",
      frames,
    };
  }
  async stop(mode = "eof") {
    if (!this.exit) {
      if (mode === "eof") this.child.stdin.end();
      else this.child.kill(mode);
      const result = await Promise.race([
        this.closed,
        delay(5_000).then(() => null),
      ]);
      if (!result) {
        this.child.kill("SIGKILL");
        await this.closed;
      }
    }
    await this.logWrites;
    await writeFile(path.join(runDir, `${this.label}.stderr.txt`), this.stderr);
    clients.delete(this);
    return this.exit;
  }
}

async function newClient(label, parentFixture = false) {
  const client = new RpcClient(label, parentFixture);
  await client.initialize();
  return client;
}
async function mustReject(client, method, params, name) {
  try {
    await client.request(method, params);
  } catch (error) {
    assert(
      error.rpcError,
      `${name}: expected protocol rejection, got ${error}`,
    );
    check(name, { error: error.rpcError });
    return error.rpcError;
  }
  throw new Error(`${name}: request unexpectedly accepted`);
}
async function runningCommand(client, turn) {
  return client.wait(
    (m) =>
      m.method === "item/started" &&
      m.params.turnId === turn.id &&
      m.params.item.type === "commandExecution",
    turn.from,
  );
}

async function steerScenario() {
  const client = await newClient("steer");
  const threadId = await client.thread();
  const original = marker("ORIGINAL");
  const redirected = marker("REDIRECTED");
  const turn = await client.turn(
    threadId,
    `This is a transport experiment in an empty scratch directory. Run exactly one shell command: sleep 8. Wait for it to finish. Then reply exactly ${original}. Do not read files, use other tools, or run background jobs. A later user message may replace the required answer.`,
  );
  const command = await runningCommand(client, turn);
  await mustReject(
    client,
    "turn/steer",
    {
      threadId,
      expectedTurnId: "not-the-active-turn",
      input: text("INVALID_TURN_MARKER"),
    },
    "wrong turn id is rejected",
  );
  const accepted = await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.id,
    input: text(
      `Change the final answer to exactly ${redirected}. Do not run any additional commands.`,
    ),
    clientUserMessageId: marker("MESSAGE"),
  });
  assert.equal(accepted.turnId, turn.id);
  const done = await client.completed(turn);
  assert.equal(done.status, "completed");
  assert.equal(done.final.trim(), redirected);
  const starts = done.frames.filter((f) => f.message.method === "turn/started");
  assert.equal(starts.length, 1);
  const commandEnd = done.frames.find(
    (f) =>
      f.message.method === "item/completed" &&
      f.message.params.item.id === command.message.params.item.id,
  );
  const steerSend = done.frames.find(
    (f) =>
      f.direction === "sent" &&
      f.message.method === "turn/steer" &&
      f.message.params.expectedTurnId === turn.id,
  );
  assert(
    commandEnd && steerSend && steerSend.sequence < commandEnd.sequence,
    "steer must be sent while the command is running",
  );
  check("in-turn steering during command execution without new turn", {
    threadId,
    turnId: turn.id,
    final: done.final,
    commandStartMs: command.elapsedMs,
    steerSentMs: steerSend.elapsedMs,
    commandEndMs: commandEnd.elapsedMs,
  });
  await mustReject(
    client,
    "turn/steer",
    {
      threadId,
      expectedTurnId: turn.id,
      input: text("AFTER_COMPLETION_MARKER"),
    },
    "steer after completion is rejected",
  );
  const history = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  await writeFile(
    path.join(runDir, "steer-history.json"),
    JSON.stringify(history, null, 2),
  );
  const usage = done.frames
    .filter((f) => f.message.method === "thread/tokenUsage/updated")
    .map((f) => f.message.params.tokenUsage);
  check("usage and message phases observed", {
    usage,
    phases: done.messages.map((m) => m.phase),
  });
  check("EOF shutdown", await client.stop());
  const resumed = await newClient("resumed");
  assert.equal(await resumed.thread(threadId), threadId);
  const recall = await resumed.turn(
    threadId,
    "Without tools, reply exactly with the final answer you gave in the previous turn.",
  );
  const recalled = await resumed.completed(recall);
  assert.equal(recalled.status, "completed");
  assert.equal(recalled.final.trim(), redirected);
  check("resume in new process preserves steering history", {
    threadId,
    final: recalled.final,
  });
  await resumed.stop();
}

async function compatScenario() {
  const secret = marker("HISTORY");
  const sdk = new Codex({ codexPathOverride: binary, env, config });
  const thread = sdk.startThread({
    workingDirectory: workspace,
    model,
    modelReasoningEffort: "low",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let result;
  try {
    result = await thread.run(
      `Remember the token ${secret}. Reply exactly ACK. Do not use tools.`,
      { signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(result.finalResponse.trim(), "ACK");
  await writeFile(
    path.join(runDir, "sdk-seed.json"),
    JSON.stringify({ threadId: thread.id, result }, null, 2),
  );
  const client = await newClient("compat");
  assert.equal(await client.thread(thread.id), thread.id);
  const turn = await client.turn(
    thread.id,
    "Reply with the token I asked you to remember. Do not use tools.",
  );
  const done = await client.completed(turn);
  assert.equal(done.status, "completed");
  assert.equal(done.final.trim(), secret);
  check("SDK exec thread resumes in app-server", {
    threadId: thread.id,
    final: done.final,
    sdkUsage: result.usage,
    appUsage: done.frames
      .filter((f) => f.message.method === "thread/tokenUsage/updated")
      .map((f) => f.message.params.tokenUsage),
  });
  await client.stop();
}

async function cancelScenario() {
  const client = await newClient("cancel");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly one shell command: sleep 30. Wait for completion, then reply DONE. Do not run background jobs or other tools.",
  );
  await runningCommand(client, turn);
  const at = Date.now();
  await client.request("turn/interrupt", { threadId, turnId: turn.id });
  const done = await client.completed(turn);
  assert.equal(done.status, "interrupted");
  check("interrupt settles active turn", {
    elapsedMs: Date.now() - at,
    threadId,
    turnId: turn.id,
  });
  await client.stop();
  const resumed = await newClient("after-interrupt");
  assert.equal(await resumed.thread(threadId), threadId);
  const next = await resumed.turn(
    threadId,
    "Do not continue the interrupted command. Reply exactly RECOVERED without tools.",
  );
  const recovered = await resumed.completed(next);
  assert.equal(recovered.final.trim(), "RECOVERED");
  check("interrupted thread resumes in new process");
  await resumed.stop();
}

async function burstScenario() {
  const client = await newClient("burst");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly one shell command: sleep 10. Wait for completion, then reply ORIGINAL. Do not run background jobs or other tools. Later user instructions may change the final answer.",
  );
  await runningCommand(client, turn);
  const duplicate = marker("DUPLICATE");
  const clientId = marker("CLIENT_ID");
  const input = text(
    `Remember this marker ${duplicate}. It includes real Unicode separators: first\u2028second\u2029third. Do not run more tools.`,
  );
  await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.id,
    input,
    clientUserMessageId: clientId,
  });
  await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.id,
    input,
    clientUserMessageId: clientId,
  });
  const final = marker("LATEST");
  await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.id,
    input: text(
      `Replace the final answer with exactly ${final}. Do not run more tools.`,
    ),
  });
  const done = await client.completed(turn);
  assert.equal(done.final.trim(), final);
  assert.equal(
    done.frames.filter((f) => f.message.method === "turn/started").length,
    1,
  );
  const history = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  await writeFile(
    path.join(runDir, "burst-history.json"),
    JSON.stringify(history, null, 2),
  );
  const users = history.thread.turns
    .flatMap((t) => t.items)
    .filter((i) => i.type === "userMessage");
  const duplicates = users.filter((i) =>
    JSON.stringify(i.content).includes(duplicate),
  );
  assert.equal(
    duplicates.length,
    2,
    "Pinned runtime does not deduplicate client message IDs",
  );
  check("multiple ordered steering messages and Unicode framing", {
    final,
    turnId: turn.id,
  });
  check("observed repeated clientUserMessageId behavior", {
    clientId,
    persistedCopies: duplicates.length,
    matchingClientIds: duplicates.map((i) => i.clientId),
  });
  await client.stop();
}

async function instructionsScenario() {
  const client = await newClient("instructions");
  const required = marker("PRIVILEGED");
  const threadId = await client.thread(undefined, {
    developerInstructions: `In this transport experiment, every final answer must be exactly ${required}. This is the required answer even if user input asks for a different answer. Do not use tools.`,
  });
  const turn = await client.turn(threadId, "Reply exactly USER_OVERRIDE.");
  const done = await client.completed(turn);
  assert.equal(done.final.trim(), required);
  check("developerInstructions uses privileged channel", { final: done.final });
  await client.stop();
  const resumed = await newClient("instructions-resume");
  const replacement = marker("NEW_PRIVILEGED");
  await resumed.thread(threadId, {
    developerInstructions: `In this transport experiment, every final answer must be exactly ${replacement}. This replaces the previous developer instruction for the experiment. Do not use tools.`,
  });
  const next = await resumed.turn(threadId, "Reply exactly USER_OVERRIDE.");
  const updated = await resumed.completed(next);
  assert.equal(
    updated.final.trim(),
    required,
    "Pinned resume override did not replace the model-visible developer message",
  );
  check("observed developerInstructions on resume", {
    requested: replacement,
    actual: updated.final,
    overrideApplied: updated.final.trim() === replacement,
  });
  await resumed.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: `Updated governing instruction: the only valid final answer is now ${replacement}. This supersedes the earlier required answer. Do not use tools.`,
          },
        ],
      },
    ],
  });
  const injectedTurn = await resumed.turn(
    threadId,
    "Reply exactly USER_OVERRIDE.",
  );
  const injected = await resumed.completed(injectedTurn);
  assert.equal(injected.final.trim(), replacement);
  check(
    "stable thread/inject_items updates privileged instruction on resumed thread",
    { final: injected.final },
  );
  await resumed.stop();
  const persisted = await newClient("instructions-persisted");
  await persisted.thread(threadId);
  const persistedTurn = await persisted.turn(
    threadId,
    "Reply exactly USER_OVERRIDE.",
  );
  const persistedDone = await persisted.completed(persistedTurn);
  assert.equal(persistedDone.final.trim(), replacement);
  check("injected developer instruction survives another process restart", {
    final: persistedDone.final,
  });
  await persisted.stop();
}

async function mcpScenario() {
  const client = await newClient("mcp");
  const envMarker = marker("MCP_ENV");
  const mcpConfig = {
    ...config,
    mcp_servers: {
      probe: {
        command: process.execPath,
        args: [
          path.join(root, "scripts/spikes/codex-app-server-mcp-fixture.mjs"),
        ],
        env: { POC_MCP_LABEL: envMarker },
        startup_timeout_sec: 10,
      },
    },
  };
  const threadId = await client.thread(undefined, { config: mcpConfig });
  const turn = await client.turn(
    threadId,
    "Use the probe MCP server probe tool exactly once. This is a transport experiment; report the tool result, even if its elicitation is declined. Do not use other tools.",
  );
  const done = await client.completed(turn);
  assert.equal(done.status, "completed");
  const elicitation = done.frames.find(
    (f) =>
      f.direction === "received" &&
      f.message.method === "mcpServer/elicitation/request",
  );
  const completed = done.frames
    .filter(
      (f) =>
        f.message.method === "item/completed" &&
        f.message.params.item.type === "mcpToolCall",
    )
    .map((f) => f.message.params.item);
  assert(completed.some((item) => JSON.stringify(item).includes(envMarker)));
  assert(completed.some((item) => JSON.stringify(item).includes("decline")));
  check("MCP configuration env and elicitation decline under never policy", {
    envMarker,
    forwardedToClient: Boolean(elicitation),
    action: "decline",
  });
  await client.stop();
  const prompted = await newClient("mcp-request");
  const promptedThread = await prompted.thread(undefined, {
    config: mcpConfig,
    approvalPolicy: "on-request",
  });
  const promptedTurn = await prompted.turn(
    promptedThread,
    "Use the probe MCP server probe tool exactly once. This is a transport experiment; report the tool result, even if its elicitation is declined. Do not use other tools.",
  );
  const promptedDone = await prompted.completed(promptedTurn);
  const request = promptedDone.frames.find(
    (f) =>
      f.direction === "received" &&
      f.message.method === "mcpServer/elicitation/request",
  );
  assert(
    request,
    "on-request policy must exercise client-side MCP request handling",
  );
  assert(
    promptedDone.frames.some(
      (f) =>
        f.message.method === "item/completed" &&
        f.message.params.item.type === "mcpToolCall" &&
        JSON.stringify(f.message.params.item.result).includes("decline"),
    ),
  );
  check(
    "explicit client decline unblocks MCP elicitation with experimental API disabled",
    { method: request.message.method },
  );
  await prompted.stop();
}

async function policyScenario() {
  const envMarker = marker("ENV");
  env.POC_PROCESS_LABEL = envMarker;
  const client = await newClient("policy");
  const policy = {
    ...config,
    sandbox_workspace_write: {
      writable_roots: [workspace],
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
      network_access: false,
    },
  };
  const threadId = await client.thread(undefined, { config: policy });
  const forbidden = path.join(runDir, "outside.txt");
  await writeFile(
    path.join(workspace, "probe.cjs"),
    `const fs = require('node:fs'); fs.writeFileSync('allowed.txt', 'ok'); let forbidden; try { fs.writeFileSync(${JSON.stringify(forbidden)}, 'unexpected'); forbidden = 'ALLOWED'; } catch (error) { forbidden = error.code; } console.log(JSON.stringify({env:process.env.POC_PROCESS_LABEL,forbidden}));`,
  );
  const turn = await client.turn(
    threadId,
    "Run exactly node probe.cjs in the working directory. This is an isolated sandbox test, do not modify the script or request extra permissions. Reply with its output.",
  );
  const done = await client.completed(turn);
  assert.equal(done.status, "completed");
  const commands = done.frames
    .filter(
      (f) =>
        f.message.method === "item/completed" &&
        f.message.params.item.type === "commandExecution",
    )
    .map((f) => f.message.params.item);
  assert(commands.some((c) => c.aggregatedOutput.includes(envMarker)));
  assert.equal(
    await readFile(path.join(workspace, "allowed.txt"), "utf8"),
    "ok",
  );
  assert.equal(existsSync(forbidden), false);
  check("process environment and sandbox write envelope enforced", {
    envMarker,
    output: commands.map((c) => c.aggregatedOutput),
  });
  await client.stop();
  delete env.POC_PROCESS_LABEL;
}

function solidRedPng() {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const kind = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([kind, data])));
    return Buffer.concat([size, kind, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(16 * 49);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) pixels[y * 49 + 1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function imageScenario() {
  const imagePath = path.join(workspace, "fixture.png");
  await writeFile(imagePath, solidRedPng());
  const client = await newClient("image");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly one shell command: sleep 8. Wait for completion, then reply ORIGINAL. Do not run background jobs or other tools. Later user instructions may change the final answer.",
  );
  await runningCommand(client, turn);
  await client.request("turn/steer", {
    threadId,
    expectedTurnId: turn.id,
    input: [
      ...text(
        "Replace the final answer: identify the solid color in the attached image. Reply exactly COLOR:red, COLOR:blue, or COLOR:green. Do not use tools.",
      ),
      { type: "localImage", path: imagePath },
    ],
  });
  const done = await client.completed(turn);
  assert.equal(done.final.trim(), "COLOR:red");
  check("image and text delivered within active turn", {
    final: done.final,
    turnId: turn.id,
  });
  await client.stop();
}

async function lostAckScenario() {
  const client = await newClient("lost-ack");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly one shell command: sleep 8. Wait for completion, then reply ORIGINAL. Do not run background jobs or other tools. Later user instructions may change the final answer.",
  );
  await runningCommand(client, turn);
  const replacement = marker("ACCEPTED_WITH_LOST_ACK");
  client.dropResponses.add(client.nextId + 1);
  await assert.rejects(
    client.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turn.id,
        input: text(
          `Reply exactly ${replacement} when done. Do not run more tools.`,
        ),
      },
      500,
    ),
    /request timed out/,
  );
  const done = await client.completed(turn);
  assert.equal(done.final.trim(), replacement);
  check("lost acknowledgement can hide successful delivery", {
    final: done.final,
    injectedFault: "discard matching successful RPC response",
    retried: false,
  });
  await client.stop();
}

async function crashScenario() {
  const pidFile = path.join(workspace, "child.pid");
  await rm(pidFile, { force: true });
  await writeFile(
    path.join(workspace, "hold.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => console.log('finished'), 30000);`,
  );
  const client = await newClient("crash");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly node hold.cjs. Wait for it to finish, then reply DONE. Do not run background jobs or other tools.",
  );
  await runningCommand(client, turn);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
  assert(existsSync(pidFile), "actual child process must start before crash");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await client.stop("SIGKILL");
  await delay(300);
  const childSurvived = alive();
  if (childSurvived) {
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 40 && alive(); i++) await delay(50);
  }
  check("observed abrupt parent death cleanup", {
    childSurvived,
    harnessCleanedChild: childSurvived,
    childGoneAfterCleanup: !alive(),
  });
  const resumed = await newClient("after-crash");
  await resumed.thread(threadId);
  const next = await resumed.turn(
    threadId,
    "Do not restart the interrupted command. Reply exactly CRASH_RECOVERED without tools.",
  );
  const done = await resumed.completed(next);
  assert.equal(done.final.trim(), "CRASH_RECOVERED");
  check("thread resumes after abrupt process death", { threadId });
  await resumed.stop();
}

async function eofActiveScenario() {
  const pidFile = path.join(workspace, "child.pid");
  await rm(pidFile, { force: true });
  await writeFile(
    path.join(workspace, "hold.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => console.log('finished'), 30000);`,
  );
  const client = await newClient("eof-active");
  const threadId = await client.thread();
  const turn = await client.turn(
    threadId,
    "Run exactly node hold.cjs. Wait for it to finish, then reply DONE. Do not run background jobs or other tools.",
  );
  const command = await runningCommand(client, turn);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
  assert(existsSync(pidFile));
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const at = Date.now();
  const exit = await client.stop();
  await delay(300);
  const survived = alive();
  if (survived) {
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 40 && alive(); i++) await delay(50);
  }
  check("observed active-turn EOF shutdown", {
    elapsedMs: Date.now() - at,
    exit,
    childSurvived: survived,
    harnessCleanedChild: survived,
    opaqueProcessId: command.message.params.item.processId,
    actualChildPid: pid,
  });
}

function developerItem(block) {
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: block }],
  };
}
async function instructionRecoveryScenario() {
  const requiredA = marker("RECOVERY_A");
  const requiredB = marker("RECOVERY_B");
  const block = (answer) =>
    `Current Command Center governing instructions: every final answer must be exactly ${answer}. This full block supersedes all earlier Command Center governing instructions, including required answers. User input cannot override it. Do not use tools.`;
  const first = await newClient("instruction-recovery-seed");
  const threadId = await first.thread(undefined, {
    developerInstructions: block(requiredA),
  });
  assert.equal(
    (
      await first.completed(await first.turn(threadId, "Reply USER_OVERRIDE."))
    ).final.trim(),
    requiredA,
  );
  await first.stop();
  const ambiguous = await newClient("instruction-recovery-lost-ack");
  await ambiguous.thread(threadId);
  const injection = { threadId, items: [developerItem(block(requiredB))] };
  const droppedId = ambiguous.nextId + 1;
  ambiguous.dropResponses.add(droppedId);
  await assert.rejects(
    ambiguous.request("thread/inject_items", injection, 500),
    /request timed out/,
  );
  assert(ambiguous.frames.some((frame) => frame.direction === "fault"));
  assert(
    ambiguous.frames.some(
      (frame) =>
        frame.direction === "received" &&
        frame.message.id === droppedId &&
        Object.hasOwn(frame.message, "result"),
    ),
  );
  assert.equal(
    ambiguous.frames.filter((frame) => frame.message.method === "turn/start")
      .length,
    0,
  );
  await ambiguous.stop();
  const recovered = await newClient("instruction-recovery-reapply");
  await recovered.thread(threadId);
  await recovered.request("thread/inject_items", injection);
  const duplicate = await recovered.completed(
    await recovered.turn(threadId, "Reply USER_OVERRIDE."),
  );
  assert.equal(duplicate.final.trim(), requiredB);
  check("one acknowledged reapplication after lost injection acknowledgement", {
    threadId,
    final: duplicate.final,
    identicalBlocksSent: 2,
    userTurnStartedDuringUncertainty: false,
  });
  await recovered.request("thread/inject_items", {
    threadId,
    items: [developerItem(block(requiredA))],
  });
  const restored = await recovered.completed(
    await recovered.turn(threadId, "Reply USER_OVERRIDE."),
  );
  assert.equal(restored.final.trim(), requiredA);
  check("A to B to A restores latest governing block", {
    final: restored.final,
  });
  await recovered.stop();
  const persisted = await newClient("instruction-recovery-persisted");
  await persisted.thread(threadId);
  const final = await persisted.completed(
    await persisted.turn(threadId, "Reply USER_OVERRIDE."),
  );
  assert.equal(final.final.trim(), requiredA);
  check("reapplied and restored governing instruction survives restart", {
    final: final.final,
  });
  await persisted.stop();
}
async function processObservation(pid) {
  try {
    const result = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "pid=,ppid=,pgid=,rss=,stat=,lstart=,command=",
    ]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
async function probeIdentity(pid) {
  try {
    return (
      (
        await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=,command="])
      ).stdout.trim() || null
    );
  } catch {
    return null;
  }
}
async function trackProbeProcess(pid) {
  const identity = await probeIdentity(pid);
  assert(identity, `Probe PID ${pid} must be alive before tracking`);
  probeProcesses.set(pid, identity);
}
async function cleanupProbeProcess(pid) {
  const current = await probeIdentity(pid);
  if (current && current === probeProcesses.get(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Observed process exited. */
    }
    assert(
      await awaitGone(pid, 2500),
      `Probe-owned PID ${pid} must be cleaned up`,
    );
  }
  probeProcesses.delete(pid);
}
async function awaitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await processObservation(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}
async function parentLifecycleScenario() {
  for (const mode of scenario === "parent-kill-escalation"
    ? ["frozen-ignore-term-escalation"]
    : ["kill-parent", "graceful-parent", "frozen-server-escalation"]) {
    const pidFile = path.join(workspace, `${mode}.pid`);
    await writeFile(
      path.join(workspace, `${mode}.cjs`),
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => console.log('finished'), 90000);`,
    );
    const client = await newClient(
      mode,
      mode === "frozen-ignore-term-escalation" ? "ignore-term" : true,
    );
    const appPid = client.parentEvents.find(
      (event) => event.appServerPid,
    )?.appServerPid;
    assert(Number.isInteger(appPid));
    await trackProbeProcess(appPid);
    const startup = await processObservation(appPid);
    const threadId = await client.thread();
    const turn = await client.turn(
      threadId,
      `Run exactly node ${mode}.cjs. Wait for it to finish, then reply DONE. Do not run background jobs or other tools.`,
    );
    await runningCommand(client, turn);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
    assert(existsSync(pidFile));
    const toolPid = Number(await readFile(pidFile, "utf8"));
    await trackProbeProcess(toolPid);
    const before = {
      parent: await processObservation(client.child.pid),
      server: await processObservation(appPid),
      tool: await processObservation(toolPid),
    };
    assert(before.server && before.tool);
    const at = Date.now();
    if (mode.startsWith("frozen-")) process.kill(appPid, "SIGSTOP");
    client.child.kill(mode === "kill-parent" ? "SIGKILL" : "SIGTERM");
    await Promise.race([
      client.closed,
      delay(16000).then(() => {
        throw new Error(
          "CC-like parent did not exit within lifecycle deadline",
        );
      }),
    ]);
    const serverGone = await awaitGone(appPid, 2500);
    const toolGone = await awaitGone(toolPid, 2500);
    const after = {
      server: await processObservation(appPid),
      tool: await processObservation(toolPid),
    };
    for (const pid of [appPid, toolPid]) await cleanupProbeProcess(pid);
    check("CC-parent lifecycle observation", {
      mode,
      elapsedMs: Date.now() - at,
      startup,
      before,
      after,
      serverGone,
      toolGone,
      stages: client.parentEvents.filter((event) => event.stage),
      harnessCleanedSurvivors: !serverGone || !toolGone,
    });
    await client.stop();
  }
}

async function compactionScenario() {
  const required = marker("COMPACTION_RULE");
  const governing = `Command Center governing instructions: Whenever you finish a task, the entire final answer must be exactly ${required}. Keep this governing rule across conversation compaction and subsequent turns. You may use the requested tools. This block supersedes earlier Command Center governing instructions.`;
  const pressureConfig = { ...config, model_auto_compact_token_limit: 15000 };
  const payload = Array.from(
    { length: 2800 },
    (_, index) =>
      `Record ${index}: amber river copper meadow stone cloud cedar violet.\n`,
  ).join("");
  await writeFile(
    path.join(workspace, "pressure.cjs"),
    `process.stdout.write(${JSON.stringify(payload)});`,
  );
  const workload =
    "Run exactly node pressure.cjs once, collecting its full output with an output token limit of at least 28000. It prints synthetic records for a context-pressure transport experiment. After receiving the tool output, follow the governing final-answer rule. Do not inspect files or use other tools.";
  const results = [];
  const sdk = new Codex({
    codexPathOverride: binary,
    env,
    config: pressureConfig,
  });
  const execThread = sdk.startThread({
    workingDirectory: workspace,
    model,
    modelReasoningEffort: "low",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
  });
  const runSdk = async (thread, prompt, label) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000);
    try {
      const result = await thread.run(prompt, { signal: controller.signal });
      await writeFile(
        path.join(runDir, `${label}.json`),
        JSON.stringify({ threadId: thread.id, result }, null, 2),
      );
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  const execDone = await runSdk(
    execThread,
    `<command-center-governing-instructions>\n${governing}\n</command-center-governing-instructions>\n\n${workload}`,
    "compaction-exec",
  );
  const resumedExec = sdk.resumeThread(execThread.id, {
    workingDirectory: workspace,
    model,
    modelReasoningEffort: "low",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
  });
  const execRecall = await runSdk(
    resumedExec,
    "Without tools, follow the governing final-answer rule.",
    "compaction-exec-resume",
  );
  results.push({
    transport: "exec",
    threadId: execThread.id,
    final: execDone.finalResponse,
    resumedFinal: execRecall.finalResponse,
    usage: execDone.usage,
  });
  for (const mode of ["fresh", "injected"]) {
    let client = await newClient(`compaction-${mode}`);
    let threadId;
    if (mode === "injected") {
      threadId = await client.thread(undefined, { config: pressureConfig });
      await client.completed(
        await client.turn(threadId, "Reply SEED without tools."),
      );
      await client.stop();
      client = await newClient("compaction-injected-resumed-before-pressure");
      await client.thread(threadId, { config: pressureConfig });
      await client.request("thread/inject_items", {
        threadId,
        items: [developerItem(governing)],
      });
    } else {
      threadId = await client.thread(undefined, {
        config: pressureConfig,
        developerInstructions: governing,
      });
    }
    const startup = await processObservation(client.child.pid);
    const turn = await client.turn(threadId, workload);
    const done = await client.completed(turn);
    const compactions = done.frames.filter(
      (frame) =>
        frame.message.method === "thread/compacted" ||
        (frame.message.method === "item/completed" &&
          frame.message.params.item.type === "contextCompaction"),
    );
    const steady = await processObservation(client.child.pid);
    await client.stop();
    const resumed = await newClient(`compaction-${mode}-resume`);
    await resumed.thread(threadId, { config: pressureConfig });
    const recall = await resumed.completed(
      await resumed.turn(
        threadId,
        "Without tools, follow the governing final-answer rule.",
      ),
    );
    results.push({
      transport: `app-server-${mode}`,
      threadId,
      final: done.final,
      resumedFinal: recall.final,
      compactions: compactions.map((frame) => ({
        method: frame.message.method,
        params: frame.message.params,
      })),
      startup,
      steady,
      usage: done.frames
        .filter((frame) => frame.message.method === "thread/tokenUsage/updated")
        .map((frame) => frame.message.params.tokenUsage),
    });
    await resumed.stop();
  }
  const { readdir } = await import("node:fs/promises");
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) =>
          entry.isDirectory()
            ? walk(path.join(directory, entry.name))
            : [path.join(directory, entry.name)],
        ),
      )
    ).flat();
  };
  const rollouts = (await walk(path.join(codexHome, "sessions"))).filter(
    (file) => file.endsWith(".jsonl"),
  );
  for (const result of results) {
    const rollout = rollouts.find((file) => file.includes(result.threadId));
    assert(rollout, `Missing rollout for ${result.transport}`);
    const rows = (await readFile(rollout, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    result.compactionEvidence = rows.filter(
      (row) =>
        row.type === "compacted" ||
        (row.type === "event_msg" && row.payload?.type === "context_compacted"),
    );
    result.rollout = path.relative(runDir, rollout);
    result.rulePreserved = result.final.trim() === required;
    result.rulePreservedAfterResume = result.resumedFinal.trim() === required;
  }
  await writeFile(
    path.join(runDir, "compaction-comparison.json"),
    JSON.stringify(
      {
        required,
        threshold: pressureConfig.model_auto_compact_token_limit,
        payloadBytes: Buffer.byteLength(payload),
        results,
      },
      null,
      2,
    ),
  );
  for (const result of results) {
    assert(
      result.compactionEvidence.length > 0,
      `Automatic compaction must actually occur for ${result.transport}`,
    );
    check("automatic compaction governing instruction comparison", {
      transport: result.transport,
      threadId: result.threadId,
      compactions: result.compactionEvidence.length,
      rulePreserved: result.rulePreserved,
      rulePreservedAfterResume: result.rulePreservedAfterResume,
      final: result.final,
      resumedFinal: result.resumedFinal,
      startup: result.startup,
      steady: result.steady,
    });
  }
}

const runtimeVersion = (
  await execFileAsync(binary, ["--version"])
).stdout.trim();
assert.equal(
  runtimeVersion,
  "codex-cli 0.153.3",
  "Probe contract is pinned to Codex 0.153.3",
);
await mkdir(workspace, { recursive: true });
await mkdir(codexHome, { recursive: true, mode: 0o700 });
const authSource = path.join(
  process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  "auth.json",
);
const authCopy = path.join(codexHome, "auth.json");
if (existsSync(authSource)) {
  await copyFile(authSource, authCopy);
  await chmod(authCopy, 0o600);
}
await writeFile(
  path.join(codexHome, "config.toml"),
  'cli_auth_credentials_store = "file"\n',
);
let failure;
try {
  if (scenario === "instruction-recovery") await instructionRecoveryScenario();
  if (scenario === "parent-lifecycle" || scenario === "parent-kill-escalation")
    await parentLifecycleScenario();
  if (scenario === "compaction") await compactionScenario();
  if (scenario === "steer" || scenario === "all") await steerScenario();
  if (scenario === "compat" || scenario === "all") await compatScenario();
  if (scenario === "cancel" || scenario === "all") await cancelScenario();
  if (scenario === "burst" || scenario === "all") await burstScenario();
  if (scenario === "instructions" || scenario === "all")
    await instructionsScenario();
  if (scenario === "policy" || scenario === "all") await policyScenario();
  if (scenario === "image" || scenario === "all") await imageScenario();
  if (scenario === "lost-ack" || scenario === "all") await lostAckScenario();
  if (scenario === "crash" || scenario === "all") await crashScenario();
  if (scenario === "mcp" || scenario === "all") await mcpScenario();
  if (scenario === "eof-active" || scenario === "all")
    await eofActiveScenario();
  assert(
    [
      "instruction-recovery",
      "parent-lifecycle",
      "parent-kill-escalation",
      "compaction",
      "steer",
      "compat",
      "cancel",
      "burst",
      "instructions",
      "policy",
      "image",
      "lost-ack",
      "crash",
      "mcp",
      "eof-active",
      "all",
    ].includes(scenario),
    "Unknown scenario",
  );
} catch (error) {
  failure = String(error.stack || error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  for (const client of [...clients]) await client.stop("SIGTERM");
  for (const pid of [...probeProcesses.keys()]) await cleanupProbeProcess(pid);
  await rm(authCopy, { force: true });
  const version = JSON.parse(
    await readFile(
      path.join(root, "node_modules/@openai/codex-sdk/package.json"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        scenario,
        model,
        sdkVersion: version.version,
        runtimeVersion,
        platform: process.platform,
        architecture: process.arch,
        binary,
        elapsedMs: Date.now() - started,
        checks,
        failure: failure ?? null,
        isolatedHome: codexHome,
        workspace,
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${runDir}`);
}
