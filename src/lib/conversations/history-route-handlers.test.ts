import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  readContainedTranscriptImageBytes,
  transcriptImagesRoot,
} from "@/lib/images/transcript-images";
import {
  readTranscriptEntriesWithSeq,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptReadCacheForTesting,
} from "@/lib/prompt/transcript";

import { createHistoryEntryService } from "./history-entry-service";
import {
  renderCompactTranscript,
  renderOptionsSchema,
} from "./transcript-render";
import { createHistoryImageService } from "./history-image-service";
import { createHistoryRouteHandlers } from "./history-route-handlers";
import { makeConversationState } from "./testing/conversation-state-fixture";

const TEST_DIR = path.join(
  "/tmp",
  `cc-history-routes-${process.pid}-${Date.now()}`,
);
const CONFIG_DIR = path.join(TEST_DIR, "config");
const PROJECT_NAME = "alpha";
const PROJECT_PATH = "/projects/alpha";
const SESSION_NAME = "csm-alpha";
const CONVERSATION_ID = "conv-history";

/** A real 1x1 PNG and a real 1x1 GIF, so assertions hash actual bytes. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Larger than any presentation excerpt limit the bounded reader applies. */
const HUGE_TOOL_RESULT = "R".repeat(200_000);

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

let transcriptPath = "";
let storedImagePath = "";
let missingImagePath = "";
let handlers: ReturnType<typeof createHistoryRouteHandlers>;

interface ScopeCase {
  scope: "session" | "project";
  params: Record<string, string>;
  base: string;
}

const SESSION_CASE: ScopeCase = {
  scope: "session",
  params: {
    name: PROJECT_NAME,
    session: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  },
  base: `/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/conversations/${CONVERSATION_ID}`,
};

const PROJECT_CASE: ScopeCase = {
  scope: "project",
  params: { name: PROJECT_NAME, conversationId: CONVERSATION_ID },
  base: `/api/projects/${PROJECT_NAME}/conversations/${CONVERSATION_ID}`,
};

beforeAll(async () => {
  const imagesDir = path.join(
    transcriptImagesRoot(CONFIG_DIR),
    CONVERSATION_ID,
  );
  await mkdir(imagesDir, { recursive: true });
  storedImagePath = path.join(imagesDir, "stored.png");
  missingImagePath = path.join(imagesDir, "gone.png");
  await writeFile(storedImagePath, Buffer.from(PNG_BASE64, "base64"));

  transcriptPath = path.join(TEST_DIR, "history.jsonl");
  await writeFile(
    transcriptPath,
    [
      // seq 0 — a paired marker/reference: ONE displayed image.
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [
          { type: "text", text: "stored screenshot" },
          {
            type: "image_marker",
            index: 1,
            mediaType: "image/png",
            imagePath: storedImagePath,
          },
          {
            type: "image_ref",
            mediaType: "image/png",
            imagePath: storedImagePath,
          },
        ],
      }),
      // seq 1 — an inline image alongside a missing external asset.
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [
          { type: "image", mediaType: "image/gif", base64Data: GIF_BASE64 },
          {
            type: "image_ref",
            mediaType: "image/png",
            imagePath: missingImagePath,
          },
        ],
      }),
      // seq 2 — a system frame the adapter does not project as an entry.
      JSON.stringify({ type: "system", timestamp: "t", raw: { init: true } }),
      // seq 3 — thinking plus an oversized tool result.
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [
          { type: "thinking", text: "private reasoning about the fix" },
          { type: "text", text: "ran the suite" },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: HUGE_TOOL_RESULT,
          },
        ],
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTranscriptEntriesCacheForTesting();
  _resetTranscriptReadCacheForTesting();
  const conversation = makeConversationState({
    id: CONVERSATION_ID,
    transcriptPath,
  });
  handlers = createHistoryRouteHandlers({
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === PROJECT_PATH && sessionName === SESSION_NAME
        ? { conversations: [conversation] }
        : null,
    getProjectConversation: async (projectPath, conversationId) =>
      projectPath === PROJECT_PATH && conversationId === CONVERSATION_ID
        ? conversation
        : null,
    entryService: createHistoryEntryService({
      readTranscriptEntries: readTranscriptEntriesWithSeq,
    }),
    imageService: createHistoryImageService({
      readTranscriptEntries: readTranscriptEntriesWithSeq,
      readImageBytes: (imagePath) =>
        readContainedTranscriptImageBytes(
          imagePath,
          transcriptImagesRoot(CONFIG_DIR),
        ),
    }),
    auth: {
      requireToken: async () => null,
      validateOptionalToken: async () => ({ kind: "absent" }) as const,
    },
  });
});

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`);
}

describe.each([SESSION_CASE, PROJECT_CASE])(
  "history evidence routes ($scope scope)",
  (scopeCase) => {
    const entry = () =>
      scopeCase.scope === "session"
        ? handlers.sessionEntry
        : handlers.projectEntry;
    const image = () =>
      scopeCase.scope === "session"
        ? handlers.sessionImage
        : handlers.projectImage;

    describe("GET /history/entries/<seq>", () => {
      it("streams the complete entry, oversized tool result included", async () => {
        const response = await entry()(
          req(`${scopeCase.base}/history/entries/3`),
          ctx({ ...scopeCase.params, seq: "3" }),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "text/plain; charset=utf-8",
        );
        expect(response.body).not.toBeNull();
        const text = await response.text();
        expect(text).toContain(HUGE_TOOL_RESULT);
        expect(text.length).toBeGreaterThan(HUGE_TOOL_RESULT.length);
        expect(response.headers.get("x-cc-entry-bytes")).toBe(
          String(Buffer.byteLength(text, "utf-8")),
        );
        expect(response.headers.get("x-cc-entry-sha256")).toBe(
          createHash("sha256").update(text, "utf-8").digest("hex"),
        );
        expect(response.headers.get("x-cc-entry-seq")).toBe("3");
      });

      it("delivers the export in chunks the bounded reader would have capped", async () => {
        const response = await entry()(
          req(`${scopeCase.base}/history/entries/3`),
          ctx({ ...scopeCase.params, seq: "3" }),
        );

        const body = response.body;
        if (body === null) throw new Error("entry export has no stream");
        const reader = body.getReader();
        let chunks = 0;
        let bytes = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks += 1;
          bytes += next.value.byteLength;
        }
        // Streamed, not collected: the export leaves as many chunks.
        expect(chunks).toBeGreaterThan(1);
        expect(bytes).toBeGreaterThan(HUGE_TOOL_RESULT.length);

        // The same entry through the ordinary bounded reader is excerpted, so
        // the export is genuinely lifting a presentation cap rather than
        // repeating what a read already returns.
        const read = renderCompactTranscript(
          {
            conversationId: CONVERSATION_ID,
            entries: (await readTranscriptEntriesWithSeq(transcriptPath))
              .entries,
            maxSeq: 3,
          },
          renderOptionsSchema.parse({}),
        );
        expect(JSON.stringify(read)).not.toContain(HUGE_TOOL_RESULT);
        expect(JSON.stringify(read).length).toBeLessThan(bytes);
      });

      it("omits thinking unless it is explicitly requested", async () => {
        const withoutThinking = await entry()(
          req(`${scopeCase.base}/history/entries/3`),
          ctx({ ...scopeCase.params, seq: "3" }),
        );
        expect(await withoutThinking.text()).not.toContain(
          "private reasoning about the fix",
        );
        expect(withoutThinking.headers.get("x-cc-entry-thinking-omitted")).toBe(
          "1",
        );

        const withThinking = await entry()(
          req(`${scopeCase.base}/history/entries/3?includeThinking=true`),
          ctx({ ...scopeCase.params, seq: "3" }),
        );
        expect(await withThinking.text()).toContain(
          "private reasoning about the fix",
        );
        expect(withThinking.headers.get("x-cc-entry-thinking-omitted")).toBe(
          "0",
        );
      });

      it("returns bounded metadata with the entry's image handles", async () => {
        const response = await entry()(
          req(`${scopeCase.base}/history/entries/1?format=metadata`),
          ctx({ ...scopeCase.params, seq: "1" }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.entry.seq).toBe(1);
        expect(body.entry).not.toHaveProperty("lines");
        expect(body.entry.images).toEqual([
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            seq: 1,
            contentBlockIndex: 0,
            storage: "inline",
            mediaType: "image/gif",
          }),
          expect.objectContaining({
            contentBlockIndex: 1,
            storage: "external",
          }),
        ]);
      });

      it("refuses a malformed sequence with 400 and an unknown one with 404", async () => {
        const malformed = await entry()(
          req(`${scopeCase.base}/history/entries/abc`),
          ctx({ ...scopeCase.params, seq: "abc" }),
        );
        expect(malformed.status).toBe(400);
        expect((await malformed.json()).issues[0].path).toBe("seq");

        const unknown = await entry()(
          req(`${scopeCase.base}/history/entries/99`),
          ctx({ ...scopeCase.params, seq: "99" }),
        );
        expect(unknown.status).toBe(404);
        expect((await unknown.json()).code).toBe("entry_not_found");
      });

      it("identifies an archive line the adapter does not project", async () => {
        const response = await entry()(
          req(`${scopeCase.base}/history/entries/2`),
          ctx({ ...scopeCase.params, seq: "2" }),
        );
        expect(response.status).toBe(422);
        expect((await response.json()).code).toBe("entry_unsupported");
      });

      it("404s a conversation outside this scope", async () => {
        const response = await entry()(
          req(`${scopeCase.base}/history/entries/3`),
          ctx({ ...scopeCase.params, conversationId: "conv-other", seq: "3" }),
        );
        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe("conversation_not_found");
      });
    });

    describe("GET /history/images/<seq>/<blockIndex>", () => {
      it("serves the stored bytes of a paired marker/reference as one image", async () => {
        const expected = Buffer.from(PNG_BASE64, "base64");

        for (const addressed of ["1", "2"]) {
          const response = await image()(
            req(`${scopeCase.base}/history/images/0/${addressed}`),
            ctx({ ...scopeCase.params, seq: "0", blockIndex: addressed }),
          );

          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/png");
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(sha256(bytes)).toBe(sha256(expected));
          expect(response.headers.get("x-cc-image-sha256")).toBe(
            sha256(expected),
          );
          // Either half resolves to the image-BEARING block index.
          expect(response.headers.get("x-cc-image-block-index")).toBe("2");
          expect(response.headers.get("x-cc-image-storage")).toBe("external");
        }
      });

      it("decodes an inline image to its original bytes", async () => {
        const response = await image()(
          req(`${scopeCase.base}/history/images/1/0`),
          ctx({ ...scopeCase.params, seq: "1", blockIndex: "0" }),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/gif");
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(sha256(bytes)).toBe(sha256(Buffer.from(GIF_BASE64, "base64")));
        expect(response.headers.get("x-cc-image-storage")).toBe("inline");
      });

      it("retains the original handle when the stored asset is gone", async () => {
        const response = await image()(
          req(`${scopeCase.base}/history/images/1/1`),
          ctx({ ...scopeCase.params, seq: "1", blockIndex: "1" }),
        );

        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.code).toBe("asset_unavailable");
        expect(body.handle).toEqual(
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            seq: 1,
            contentBlockIndex: 1,
            storage: "external",
          }),
        );
        expect(body.handle.command).toContain("conversation image get");
        expect(JSON.stringify(body)).not.toContain(missingImagePath);
      });

      it("refuses a non-image block", async () => {
        const response = await image()(
          req(`${scopeCase.base}/history/images/0/0`),
          ctx({ ...scopeCase.params, seq: "0", blockIndex: "0" }),
        );

        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("not_an_image_block");
      });

      it("refuses a coordinate that is not a block index", async () => {
        const response = await image()(
          req(`${scopeCase.base}/history/images/0/..%2F..%2Fetc%2Fpasswd`),
          ctx({
            ...scopeCase.params,
            seq: "0",
            blockIndex: "../../etc/passwd",
          }),
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.issues[0].path).toBe("blockIndex");
      });

      it("404s an image addressed outside this scope", async () => {
        const response = await image()(
          req(`${scopeCase.base}/history/images/0/2`),
          ctx({
            ...scopeCase.params,
            conversationId: "conv-other",
            seq: "0",
            blockIndex: "2",
          }),
        );

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe("conversation_not_found");
      });
    });
  },
);
