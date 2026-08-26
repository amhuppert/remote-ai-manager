import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  _resetLastSeqCacheForTesting,
  _resetTranscriptReadCacheForTesting,
  appendTranscriptEntry,
  appendTranscriptEntryOnce,
  getTranscriptPath,
  readConversationMessages,
} from "@/lib/prompt/transcript";
import { buildUserTranscriptBlocks } from "@/lib/workflows/conversation/build-user-transcript-blocks";
import type { ConversationImageRef } from "../../conversation";
import { conversationTranscriptFrame } from "../../transcript";
import { translateCursorImages } from "../image-input";
import { projectCursorNativeEvent } from "../transcript-projections";
import { decodeNativePayload, type CursorWorkerFrame } from "../worker/ipc";
import type { CredentialSecret } from "./credential-scan";
import { solidColorPng } from "./deterministic-image";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
  type RawArtifact,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  createLiveHarness,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
} from "./live-worker";

/**
 * An image-bearing user turn (spec R16.1, R14.2).
 *
 * The capability is only worth declaring if the image reaches the model, so
 * this case does not check that the SDK accepted an image field — it checks
 * that the answer depends on the image's content. A saturated green field
 * confines a truthful one-word answer to the narrow set accepted below, and a
 * model that never received the bytes cannot give one reliably.
 */

const IMAGE_SIZE = 128;
const IMAGE_COLOR = { red: 0, green: 200, blue: 0 };
const GREEN_IMAGE_ANSWER = /\b(?:green|lime)\b|#00[89a-f][0-9a-f]00\b/i;

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let live: LiveConversation;
let imageSha256: string;
let imageBytes: number;
let imageRef: ConversationImageRef;
/** Written by the lossless-round-trip case, published by the durable one. */
let rawArtifact: RawArtifact;
const runId = randomUUID();

function visibleAssistantText(
  events: readonly Extract<CursorWorkerFrame, { type: "nativeEvent" }>[],
): string {
  return events
    .flatMap((event) => {
      const decoded = decodeNativePayload(event.eventType, event.payload);
      if (!decoded.ok) return [];
      return projectCursorNativeEvent(
        {
          runId: event.runId,
          eventIndex: event.eventIndex,
          eventType: event.eventType,
          tagged: decoded.tagged,
          decoded: decoded.value,
        },
        {
          conversationId: live.conversationId,
          timestamp: new Date(0).toISOString(),
        },
      ).blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
    })
    .join(" ");
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });

  const png = solidColorPng(IMAGE_SIZE, IMAGE_COLOR);
  imageSha256 = createHash("sha256").update(png).digest("hex");
  imageBytes = png.length;

  live = await harness.startReady({
    sessionName: `image-${randomUUID()}`,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  });
  const imagePath = path.join(live.workspace.cwd, "acceptance-image.png");
  writeFileSync(imagePath, png, { mode: 0o600 });

  imageRef = {
    index: 1,
    mediaType: "image/png",
    path: imagePath,
    base64Data: png.toString("base64"),
  };
  // Through the production translation, bounds and all — an acceptance case
  // that hand-built the SDK shape would prove nothing about the path a real
  // turn takes.
  const translated = translateCursorImages([imageRef]);
  if (!translated.ok) {
    throw new Error(`the fixture image was rejected: ${translated.message}`);
  }

  live.attach({
    mode: "create",
    ref: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: {},
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "attachResult") !== undefined,
      90_000,
    ),
  ).toBe(true);

  live.startTurn({
    runId,
    promptText:
      "Look at the attached image. It is a single solid colour. " +
      "Reply with exactly one word: that colour's common English name. Do not use any tools.",
    images: translated.images,
    structuredOutputInstruction: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: {},
    forceExpirePersistedRun: false,
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "turnSettled") !== undefined,
      240_000,
    ),
    "the image turn did not settle",
  ).toBe(true);
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("image-bearing Cursor turn", () => {
  it("completes the turn", () => {
    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("completed");
    expect(frameOfType(live.frames, "turnSettled")?.error).toBeNull();
  });

  it("produces an answer that reflects the image's content", () => {
    const text = visibleAssistantText(framesOfType(live.frames, "nativeEvent"));
    expect(text).toMatch(GREEN_IMAGE_ANSWER);
  });

  it("emits ordered native events under the image turn's run", () => {
    const events = framesOfType(live.frames, "nativeEvent");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === runId)).toBe(true);
    expect(events.map((event) => event.eventIndex)).toEqual(
      events.map((_event, index) => index),
    );
    expect(framesOfType(live.frames, "nativeEventRejected")).toEqual([]);
  });

  it("round-trips every native event through the lossless envelope", async () => {
    const events = framesOfType(live.frames, "nativeEvent");
    const decoded = events.map((event) =>
      decodeNativePayload(event.eventType, event.payload),
    );
    expect(decoded.every((result) => result.ok)).toBe(true);

    // The raw fixture stays private: it carries the turn's full native
    // payloads. Only its digest and shape are published.
    rawArtifact = await store.writeRaw(
      "image-native-events.jsonl",
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    expect(rawArtifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("survives a durable transcript round trip with the image represented", async () => {
    // The real Command Center transcript boundary, not a private artifact: the
    // production projection, the production frame resolver, the id-checked
    // idempotent append every Cursor frame takes, and the reader a restarted
    // server uses. Anything less would prove the SDK delivered an image, not
    // that the turn survives a reload.
    const conversationId = `cursor-acceptance-image-${randomUUID()}`;
    const configDir = path.join(
      resolveAcceptanceEvidenceRoot(process.env),
      "transcripts",
    );

    const userBlocks = buildUserTranscriptBlocks({
      rewrittenPromptText: `Look at [Image #${imageRef.index}] and name its colour.`,
      imageRefs: [imageRef],
    });
    await appendTranscriptEntry(
      conversationId,
      {
        timestamp: new Date().toISOString(),
        type: "user",
        role: "user",
        content: userBlocks,
      },
      configDir,
    );

    const events = framesOfType(live.frames, "nativeEvent");
    for (const event of events) {
      const decoded = decodeNativePayload(event.eventType, event.payload);
      if (!decoded.ok)
        throw new Error(`event ${event.eventIndex} did not decode`);
      const projection = projectCursorNativeEvent(
        {
          runId: event.runId,
          eventIndex: event.eventIndex,
          eventType: event.eventType,
          tagged: decoded.tagged,
          decoded: decoded.value,
        },
        { conversationId, timestamp: new Date().toISOString() },
      );
      const frame = conversationTranscriptFrame(projection.entry);
      // Every Cursor frame must carry the run-scoped id, which is what routes
      // it through the idempotent append in production (D21). Checked rather
      // than asserted by a cast: an id-less frame would silently take the
      // ordinary append and the duplicate below would persist twice.
      const { id } = frame;
      if (typeof id !== "string") {
        throw new Error(
          `event ${event.eventIndex} produced a transcript frame with no run-scoped id`,
        );
      }
      const identified = { ...frame, id };
      // Appended twice on purpose: exactly-once has to hold at the durable
      // boundary, not just in the runtime that feeds it.
      await appendTranscriptEntryOnce(conversationId, identified, configDir);
      await appendTranscriptEntryOnce(conversationId, identified, configDir);
    }

    // Read back the way a restarted server would: a fresh path, caches cleared.
    _resetTranscriptReadCacheForTesting();
    _resetLastSeqCacheForTesting();
    const transcriptPath = await getTranscriptPath(conversationId, configDir);
    const reloaded = await readConversationMessages(transcriptPath);

    const userMessage = reloaded.find((message) => message.role === "user");
    expect(
      userMessage,
      "the user turn did not survive the reload",
    ).toBeDefined();
    const imageBlocks = (userMessage?.content ?? []).filter(
      (block) => block.type === "image_ref" || block.type === "image_marker",
    );
    expect(
      imageBlocks.length,
      "the durable transcript carries no representation of the image",
    ).toBeGreaterThan(0);
    expect(JSON.stringify(imageBlocks)).toContain(imageRef.path);

    const assistantText = reloaded
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ");
    expect(
      assistantText,
      "the image-derived answer did not survive the reload",
    ).toMatch(GREEN_IMAGE_ANSWER);

    // Exactly once despite the duplicate append: the run-scoped id is the key.
    const persistedIds = (await readFile(transcriptPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "id")
          : undefined;
      })
      .filter((id): id is string => typeof id === "string");
    expect(persistedIds.length).toBe(new Set(persistedIds).size);
    expect(persistedIds.length).toBe(events.length);

    const usage = framesOfType(live.frames, "usage").at(0);
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    await store.publish({
      caseId: "image-turn",
      outcome: "pass",
      metrics: {
        imageSha256,
        imageBytes,
        imageMediaType: "image/png",
        answerReflectsImage: true,
        nativeEventCount: events.length,
        losslessRoundTrip: true,
        durableTranscriptEntries: persistedIds.length,
        durableImageBlocks: imageBlocks.length,
        duplicateAppendsPersisted: 0,
        answerSurvivedReload: true,
        usageRecords: framesOfType(live.frames, "usage").length,
        totalTokens: usage?.totalTokens ?? null,
        costUsd: null,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [rawArtifact],
    });
  }, 120_000);
});
