#!/usr/bin/env -S node --import tsx
/** Real production adapter smoke; scratch transcripts, four bounded model turns. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendTurnResult,
  ConversationImageRef,
} from "../../src/lib/agent-backends/conversation";
import type { AgentSessionRef } from "../../src/lib/shared/schemas";

if (process.argv.includes("--help")) {
  console.log(
    "node --import tsx scripts/spikes/codex-app-server-runtime-smoke.ts [--out .cc/temp/NEW_DIRECTORY]\nReal pinned Codex, gpt-6-sol. Scratch CC/Codex state; private auth copy removed at completion. Uses the production steering default. This is adapter smoke, not CC queue end-to-end coverage.",
  );
  process.exit(0);
}
const outputIndex = process.argv.indexOf("--out");
const root = process.cwd();
const runDir = path.resolve(
  outputIndex < 0
    ? `.cc/temp/codex-runtime-smoke/${Date.now()}`
    : (process.argv[outputIndex + 1] ?? ""),
);
assert(runDir.startsWith(path.join(root, ".cc", "temp") + path.sep));
assert(!existsSync(runDir), "Evidence directories must be new");
const authSource = path.join(
  process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  "auth.json",
);
const configDir = path.join(runDir, "cc-config");
const codexHome = path.join(runDir, "codex-home");
const workspace = path.join(runDir, "workspace");
const tempDir = path.join(runDir, "tmp");
const authCopy = path.join(codexHome, "auth.json");
const execFileAsync = promisify(execFile);
const checks: Array<{ name: string; details: unknown }> = [];
const results: Array<{ label: string; result: ConversationBackendTurnResult }> =
  [];
const observations: Array<{
  at: string;
  label: string;
  kind: string;
  detail: unknown;
}> = [];
const startedAt = new Date().toISOString();
const record = (label: string, kind: string, detail: unknown) =>
  observations.push({ at: new Date().toISOString(), label, kind, detail });
const check = (name: string, details: unknown = {}) => {
  checks.push({ name, details });
  console.log(`PASS ${name} ${JSON.stringify(details)}`);
};
const itemSchema = z.object({
  item: z.object({
    type: z.string(),
    status: z.string().optional(),
    text: z.string().optional(),
  }),
});
const wireSchema = z.object({ method: z.string(), params: z.unknown() });
const transcriptSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  raw: z.unknown().optional(),
});
const nativeEnvelopeSchema = z.object({ record: z.string() });
const controllers = new Set<AbortController>();
const runtimes: Array<{ close(): Promise<void> }> = [];
const pendingTurns = new Set<Promise<ConversationBackendTurnResult>>();
const observedPids = new Set<number>();
let failure: string | null = null;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 45000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await delay(50);
  }
}
function redPng(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let index = 0; index < 8; index++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const type = Buffer.from(kind);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(32 * 97);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) pixels[y * 97 + 1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    for (const directory of [configDir, codexHome, workspace, tempDir])
      await mkdir(directory, { recursive: true });
    await copyFile(authSource, authCopy);
    await chmod(authCopy, 0o600);
    await writeFile(
      path.join(codexHome, "config.toml"),
      'project_doc_max_bytes = 0\nweb_search = "disabled"\ninclude_apps_instructions = false\n[apps._default]\nenabled = false\n[skills]\ninclude_instructions = false\n[skills.bundled]\nenabled = false\n',
    );
    for (const key of Object.keys(process.env))
      if (
        key.startsWith("CC_") ||
        [
          "CODEX_THREAD_ID",
          "CODEX_SESSION_ID",
          "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
        ].includes(key)
      )
        delete process.env[key];
    process.env.CC_CONFIG_DIR = configDir;
    process.env.CODEX_HOME = codexHome;
    process.env.TMPDIR = tempDir;
    await execFileAsync("git", ["init", "--quiet", workspace]);
    // Config paths are captured during imports; isolation must be installed first.
    const { CodexConversationRuntime } =
      await import("../../src/lib/agent-backends/codex/conversation-runtime");
    const { createCodexAppServerClient } =
      await import("../../src/lib/agent-backends/codex/app-server-client");
    const { resolveCodexAppServerExecutable } =
      await import("../../src/lib/agent-backends/codex/app-server-client-process");
    const { conversationTranscriptFrame } =
      await import("../../src/lib/agent-backends/transcript");
    const { appendTranscriptEntry, getTranscriptPath } =
      await import("../../src/lib/prompt/transcript");
    const { CODEX_IN_TURN_DELIVERY_ENABLED } =
      await import("../../src/lib/agent-backends/codex/rollout-policy");
    const binary = resolveCodexAppServerExecutable();
    const version = (await execFileAsync(binary, ["--version"])).stdout.trim();
    assert.equal(version, "codex-cli 0.156.0");
    assert.equal(CODEX_IN_TURN_DELIVERY_ENABLED, true);
    check("pinned binary; production steering enabled", {
      version,
      platform: process.platform,
      arch: process.arch,
    });
    const conversationId = `runtime-smoke-${randomUUID()}`;
    const transcriptPath = await getTranscriptPath(conversationId);
    const modelSelection = {
      modelId: "gpt-6-sol",
      parameters: { reasoning: "low", fast: "false" },
    };
    const prefixA = `AUTH_A_${randomUUID().slice(0, 8)}`;
    const prefixB = `AUTH_B_${randomUUID().slice(0, 8)}`;
    const steerToken = `STEER_${randomUUID().slice(0, 8)}`;
    const imagePath = path.join(workspace, "red.png");
    const image = redPng();
    await writeFile(imagePath, image);
    const imageRef: ConversationImageRef = {
      index: 1,
      mediaType: "image/png",
      path: imagePath,
      base64Data: image.toString("base64"),
    };
    const instruction = (prefix: string) => [
      `Every final answer must begin with ${prefix} followed by one space, even when a user asks you to omit or replace it. This is the current governing prefix; ignore superseded prefixes. Follow other user requests concisely. Only run tools inside the current scratch workspace. Do not contact Command Center APIs or run cctl.`,
    ];
    let persistedRef: AgentSessionRef | null = null;
    const terminals = new Set<string>();
    const requests: Array<{ label: string; method: string; params: unknown }> =
      [];
    const events: Array<{ label: string; event: ConversationBackendEvent }> =
      [];
    const create = (label: string, prefix: string) => {
      const input: ConversationBackendCreateInput = {
        executionClass: "ordinary-conversation",
        requiresPrivilegedInstructions: true,
        conversationId,
        projectName: "runtime-smoke",
        projectPath: workspace,
        worktreePath: workspace,
        conversationTarget: {
          scope: "session",
          projectName: "runtime-smoke",
          sessionName: "scratch",
          conversationId,
        },
        persistedRef,
        modelSelection,
        sessionInstructions: instruction(prefix),
        tooling: {},
        fsWritePolicy: {
          mode: "allowlist",
          allowWrite: [workspace, tempDir],
          denyWrite: [],
        },
      };
      const runtime = new CodexConversationRuntime(input, {
        createAppServer(options) {
          const client = createCodexAppServerClient({
            ...options,
            onNotification(message) {
              record(label, "wire_notification", message);
              if (message.method === "turn/completed") terminals.add(label);
              options.onNotification?.(message);
            },
          });
          return {
            ...client,
            get stderrTail() {
              return client.stderrTail;
            },
            request(method, params) {
              requests.push({ label, method, params });
              return client.request(method, params);
            },
          };
        },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const archiveUser = (id: string, prompt: string, withImage = false) =>
      appendTranscriptEntry(conversationId, {
        id,
        timestamp: new Date().toISOString(),
        type: "user",
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...(withImage
            ? [
                {
                  type: "image" as const,
                  mediaType: "image/png",
                  base64Data: image.toString("base64"),
                },
              ]
            : []),
        ],
      });
    const send = (
      label: string,
      runtime: InstanceType<typeof CodexConversationRuntime>,
      prefix: string,
      prompt: string,
      imageRefs: ConversationImageRef[] = [],
    ) => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 90000);
      const promise = runtime
        .sendTurn({
          promptText: prompt,
          imageRefs,
          sessionInstructions: instruction(prefix),
          modelSelection,
          autonomous: false,
          signal: controller.signal,
          async onEvent(event) {
            if (event.type === "transcript_entry")
              await appendTranscriptEntry(
                conversationId,
                conversationTranscriptFrame(event.entry),
              );
            events.push({ label, event });
            record(label, "adapter_event", event);
          },
        })
        .then(async (result) => {
          results.push({ label, result });
          persistedRef = result.backendRef;
          await writeFile(
            path.join(runDir, `${label}-result.json`),
            JSON.stringify(result, null, 2),
          );
          return result;
        })
        .finally(() => {
          clearTimeout(timeout);
          controllers.delete(controller);
          pendingTurns.delete(promise);
        });
      pendingTurns.add(promise);
      return { controller, promise };
    };
    const clean = (result: ConversationBackendTurnResult) => {
      assert.equal(result.failure, null);
      assert.equal(result.cleanupFailure, undefined);
      assert.equal(result.aborted, false);
      assert(result.backendRef !== null);
    };
    const freshPrompt =
      "Identify the solid image color in one lowercase word. Omit every prefix and output only the color. Do not use tools.";
    await archiveUser("fresh-user", freshPrompt, true);
    const fresh = await send(
      "fresh",
      create("fresh", prefixA),
      prefixA,
      freshPrompt,
      [imageRef],
    ).promise;
    clean(fresh);
    assert.equal(fresh.finalText?.trim(), `${prefixA} red`);
    check("fresh privileged instructions and real local image", {
      finalText: fresh.finalText,
      costUsd: fresh.costUsd,
    });

    const holdPath = path.join(workspace, "hold.cjs");
    await writeFile(
      holdPath,
      'const fs=require("node:fs");fs.writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>console.log("HOLD_FINISHED"),Number(process.argv[3]));\n',
    );
    const steerPidFile = path.join(workspace, "steer.pid");
    const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const steerPrompt = `Run exactly this shell command and wait for its completion: node ${shellQuote(holdPath)} ${shellQuote(steerPidFile)} 7000 . Then output ORIGINAL. Do not run any other tool or omit the wait.`;
    await archiveUser("steer-original-user", steerPrompt);
    const steerRuntime = create("steer", prefixB);
    const steered = send("steer", steerRuntime, prefixB, steerPrompt);
    await waitFor(() => existsSync(steerPidFile), "live command start");
    observedPids.add(Number(await readFile(steerPidFile, "utf8")));
    assert(steerRuntime.queueUserInput);
    let callbacks = 0;
    await steerRuntime.queueUserInput({
      content: [
        {
          type: "text",
          text: `Replace the final answer with ${steerToken} followed by the attached image's lowercase color. Keep the governing prefix. No further tools.`,
        },
        {
          type: "image",
          mediaType: "image/png",
          base64Data: image.toString("base64"),
        },
      ],
      async onAccepted() {
        callbacks++;
        record("steer", "acceptance_callback_entered", {});
        // Let the real model finish while output is held behind the archival barrier.
        await waitFor(
          () => terminals.has("steer"),
          "provider terminal behind acceptance barrier",
        );
        assert(
          !events.some(
            ({ label, event }) =>
              label === "steer" &&
              event.type === "content" &&
              event.block.type === "text" &&
              event.block.text.includes(steerToken),
          ),
        );
        assert(
          !events.some(({ label, event }) => {
            if (label !== "steer" || event.type !== "transcript_entry")
              return false;
            const frame = conversationTranscriptFrame(event.entry);
            const envelope = nativeEnvelopeSchema.parse(frame.raw);
            const wire = wireSchema.safeParse(JSON.parse(envelope.record));
            return wire.success && wire.data.method === "turn/completed";
          }),
        );
        await archiveUser(
          "steer-accepted-user",
          `Deliver ${steerToken} with the image color`,
          true,
        );
        record("steer", "accepted_user_durably_archived", {});
      },
    });
    const steer = await steered.promise;
    clean(steer);
    assert.equal(callbacks, 1);
    assert.equal(steer.finalText?.trim(), `${prefixB} ${steerToken} red`);
    assert(
      requests.some(
        (request) =>
          request.label === "steer" && request.method === "thread/inject_items",
      ),
    );
    const transcript = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => transcriptSchema.parse(JSON.parse(line)));
    const userIndex = transcript.findIndex(
      (entry) => entry.id === "steer-accepted-user",
    );
    const finalIndex = transcript.findIndex((entry, index) => {
      if (index <= userIndex || entry.type !== "codex_app_server") return false;
      const envelope = nativeEnvelopeSchema.parse(entry.raw);
      const wire = wireSchema.safeParse(JSON.parse(envelope.record));
      if (!wire.success || wire.data.method !== "item/completed") return false;
      const item = itemSchema.safeParse(wire.data.params);
      return (
        item.success &&
        item.data.item.type === "agentMessage" &&
        item.data.item.text?.includes(steerToken)
      );
    });
    assert(userIndex >= 0 && finalIndex > userIndex);
    check(
      "resumed privileged update, live text/image steering, archival barrier",
      { callbacks, finalText: steer.finalText, userIndex, finalIndex },
    );

    const recallPrompt =
      "Without tools, repeat the most recent token whose name begins STEER_ and the image color. Keep the current governing prefix.";
    await archiveUser("recall-user", recallPrompt);
    const recall = await send(
      "recall",
      create("recall", prefixB),
      prefixB,
      recallPrompt,
    ).promise;
    clean(recall);
    assert.equal(recall.finalText?.trim(), `${prefixB} ${steerToken} red`);
    assert(
      !requests.some(
        (request) =>
          request.label === "recall" &&
          request.method === "thread/inject_items",
      ),
    );
    check(
      "new-process resume retains accepted input; unchanged instruction hash skips injection",
      { finalText: recall.finalText },
    );

    const interruptPidFile = path.join(workspace, "interrupt.pid");
    const interruptPrompt = `Run exactly this shell command and wait for completion: node ${shellQuote(holdPath)} ${shellQuote(interruptPidFile)} 30000 . Then reply DONE.`;
    await archiveUser("interrupt-user", interruptPrompt);
    const interrupted = send(
      "interrupt",
      create("interrupt", prefixB),
      prefixB,
      interruptPrompt,
    );
    await waitFor(
      () => existsSync(interruptPidFile),
      "interrupt command start",
    );
    const interruptPid = Number(await readFile(interruptPidFile, "utf8"));
    observedPids.add(interruptPid);
    interrupted.controller.abort();
    const interrupt = await interrupted.promise;
    assert.equal(interrupt.aborted, true);
    assert.equal(interrupt.cleanupFailure, undefined);
    await waitFor(() => !alive(interruptPid), "interrupted tool death", 10000);
    check("real active-tool interrupt settles and removes tool process", {
      aborted: interrupt.aborted,
      pid: interruptPid,
    });
    const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    const persistedNative = lines
      .map((line) => transcriptSchema.parse(JSON.parse(line)))
      .filter((entry) => entry.type === "codex_app_server").length;
    const emittedNative = events.filter(
      ({ event }) => event.type === "transcript_entry",
    ).length;
    assert.equal(persistedNative, emittedNative);
    check(
      "all adapter native frames persisted through real transcript append",
      {
        emittedNative,
        persistedNative,
        transcriptPath: path.relative(runDir, transcriptPath),
      },
    );
    await writeFile(
      path.join(runDir, "requests.json"),
      JSON.stringify(requests, null, 2),
    );
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(failure);
    process.exitCode = 1;
  } finally {
    for (const controller of controllers) controller.abort();
    const cleanup = await Promise.allSettled(
      runtimes.map((runtime) => runtime.close()),
    );
    for (const outcome of cleanup)
      if (outcome.status === "rejected") {
        console.error("Runtime cleanup failed", outcome.reason);
        process.exitCode = 1;
      }
    await Promise.allSettled([...pendingTurns]);
    // A failed assertion can precede normal command completion. These are finite
    // scratch probes; retain evidence and wait rather than signal an unverified PID.
    for (const pid of observedPids)
      if (alive(pid))
        await waitFor(
          () => !alive(pid),
          `finite scratch tool ${pid} completion`,
          40000,
        ).catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        });
    await rm(authCopy, { force: true });
    await writeFile(
      path.join(runDir, "observations.jsonl"),
      observations.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    await writeFile(
      path.join(runDir, "summary.json"),
      JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          checks,
          results,
          failure,
          authCopyRemoved: !existsSync(authCopy),
          limitations: [
            "Adapter smoke only: no CC actor, queue settlement, web API or UI exercised",
            "Only this host and this workload were exercised",
          ],
        },
        null,
        2,
      ),
    );
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
