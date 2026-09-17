import { describe, expect, it } from "vitest";

import { renderCompactTranscript } from "@/lib/conversations/transcript-render";
import { renderOptionsSchema } from "@/lib/conversations/transcript-render";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import { runCcWithHost, artifactTextOf } from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

/**
 * Behaviour of `conversation entry get` and `conversation image get`, and the
 * round trip that matters most: a bounded `conversation read` names the
 * evidence it could not show, and the command it names must actually run. The
 * last describe block takes the reader's own follow-up strings — built by the
 * archive, not typed here — and drives them through the real dispatch.
 */

const sessionEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "self-conv",
};

const SESSION_BASE =
  "/api/projects/cc/sessions/my-session/conversations/conv-1";

interface RecordedRequest {
  path: string;
  method: string;
}

interface TestHost extends CliHost {
  requests: RecordedRequest[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function makeHost(respond: (req: RecordedRequest) => Response): TestHost {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url: string, init: FetchInit) {
      const parsed = new URL(url);
      const req = {
        path: parsed.pathname + parsed.search,
        method: (init.method ?? "GET").toUpperCase(),
      };
      requests.push(req);
      return respond(req);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

function entryMetadata(overrides: Record<string, unknown> = {}) {
  return {
    entry: {
      conversationId: "conv-1",
      seq: 148,
      kind: "message",
      role: "assistant",
      entryId: "e-148",
      timestamp: "2026-09-01T00:00:00.000Z",
      messageIndex: 12,
      includeThinking: false,
      thinkingOmitted: 2,
      bytes: 42,
      sha256: "entry-hash",
      images: [],
      ...overrides,
    },
  };
}

describe("archive refusal diagnostics", () => {
  it.each(["entry", "image"])(
    "retains oversized %s refusal details and the server instruction",
    async (kind) => {
      const error = "Archive store unavailable\n" + "é".repeat(300);
      const instruction = "Inspect the archive before retrying.";
      const host = makeHost(() =>
        jsonResponse(
          {
            error,
            code: "archive_unavailable",
            instruction,
            issues: [
              {
                path: "archive",
                message: "Archive source could not be opened",
              },
            ],
            details: { readOnly: true },
          },
          404,
        ),
      );
      const result = await runCcWithHost(
        [
          "conversation",
          kind,
          "get",
          "conv-1",
          "3",
          ...(kind === "image" ? ["0"] : []),
          "--json",
        ],
        sessionEnv,
        host,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "read",
        instruction,
        error: {
          code: "CC_OPERATION_FAILED",
          details: {
            serverCode: "archive_unavailable",
            serverMessage: error,
            serverDetails: { readOnly: true },
          },
          issues: [{ message: "Archive source could not be opened" }],
        },
      });
    },
  );
});

describe("a bounded read's follow-ups are executable commands", () => {
  function entry(
    seq: number,
    role: "user" | "assistant",
    content: MessageContentBlock[],
  ): TranscriptEntryWithSeq {
    return {
      seq,
      entryId: null,
      role,
      timestamp: "2026-09-01T00:00:00.000Z",
      content,
    };
  }

  /**
   * A transcript with one oversized tool result (the renderer excerpts it) and
   * more messages than a tiny byte budget can reach (the renderer omits them
   * whole), so both follow-up kinds are produced by production code.
   */
  function renderTruncated() {
    const entries: TranscriptEntryWithSeq[] = [
      entry(0, "user", [{ type: "text", text: "start the work" }]),
      entry(1, "assistant", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "R".repeat(20_000),
        },
      ]),
      entry(2, "user", [{ type: "text", text: "and then this" }]),
      entry(3, "assistant", [{ type: "text", text: "done" }]),
    ];
    return renderCompactTranscript(
      { conversationId: "conv-1", entries, maxSeq: 3 },
      renderOptionsSchema.parse({ maxBytes: 400 }),
    );
  }

  function argvOf(command: string): string[] {
    const tokens = command.split(" ");
    expect(tokens[0]).toBe("cctl");
    return tokens.slice(1);
  }

  it("produces both a next-sequence read and a complete-entry export", () => {
    const rendered = renderTruncated();
    const commands = [
      rendered.truncation.omittedAfter?.command,
      rendered.truncation.partialEntry?.command,
      ...rendered.truncation.excerptedEntries.map((item) => item.command),
    ].filter((value): value is string => typeof value === "string");

    expect(commands.some((c) => c.includes("--seq-range"))).toBe(true);
    expect(commands.some((c) => c.includes("entry get"))).toBe(true);
  });

  it("recovers the excerpted entry complete, at its own coordinate", async () => {
    const rendered = renderTruncated();
    const elided = [
      rendered.truncation.partialEntry,
      ...rendered.truncation.excerptedEntries,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    expect(elided.length).toBeGreaterThan(0);

    for (const entry of elided) {
      // What the reader shortened is exactly what the export must return.
      const complete = `COMPLETE-${entry.seq}-${"R".repeat(20_000)}`;
      const host = makeHost((req) =>
        req.path.includes("format=metadata")
          ? jsonResponse(entryMetadata({ seq: entry.seq }))
          : textResponse(complete),
      );

      const result = await runCcWithHost(
        argvOf(entry.command),
        sessionEnv,
        host,
      );

      expect(result.exitCode).toBe(0);
      expect(host.requests[0]?.path).toBe(
        `${SESSION_BASE}/history/entries/${entry.seq}?format=metadata`,
      );
      // Inline under the budget, in the spill file past it — either way the
      // export is the complete entry, not the excerpt the reader showed.
      const disclosed = [
        result.stdout,
        ...result.artifacts.map((_, index) => artifactTextOf(result, index)),
      ];
      expect(disclosed.some((text) => text.includes(complete))).toBe(true);
      expect(entry.elidedBytes).toBeGreaterThan(0);
    }
  });

  it("reads the omitted window starting at the exact next raw sequence", async () => {
    const rendered = renderTruncated();
    const omitted = rendered.truncation.omittedAfter;
    expect(omitted).not.toBeNull();
    if (omitted === null) return;

    const host = makeHost(() =>
      jsonResponse({
        totalMessages: 4,
        maxSeq: 3,
        units: [],
        truncated: false,
      }),
    );
    await runCcWithHost(argvOf(omitted.command), sessionEnv, host);

    const query = new URLSearchParams(
      host.requests[0]?.path.split("?")[1] ?? "",
    );
    expect(query.get("seqRange")).toBe(`${omitted.nextSeq}:${omitted.lastSeq}`);
    expect(omitted.unitCount).toBeGreaterThan(0);
  });

  it("runs every follow-up the renderer named against its real endpoint", async () => {
    const rendered = renderTruncated();
    const commands = [
      rendered.truncation.omittedAfter?.command,
      rendered.truncation.partialEntry?.command,
      ...rendered.truncation.excerptedEntries.map((item) => item.command),
    ].filter((value): value is string => typeof value === "string");

    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      const host = makeHost((req) =>
        req.path.includes("/history/entries/") &&
        req.path.includes("format=metadata")
          ? jsonResponse(entryMetadata())
          : req.path.includes("/history/entries/")
            ? textResponse("recovered entry")
            : jsonResponse({
                conversationId: "conv-1",
                omissions: {
                  thinkingOmitted: 0,
                  toolResultBytesElided: 0,
                  unitsOutsideWindow: 0,
                },
                boundaries: {
                  entries: [],
                  totalInRange: 0,
                  nextBefore: null,
                  indexCommand: null,
                },
                truncation: {
                  omittedAfter: null,
                  partialEntry: null,
                  excerptedEntries: [],
                  excerptedEntriesOmitted: 0,
                  excerptedEntriesNext: null,
                },
                totalMessages: 4,
                maxSeq: 3,
                units: [],
                truncated: false,
              }),
      );

      const result = await runCcWithHost(argvOf(command), sessionEnv, host);
      expect(
        result.exitCode === 0 ? command : `${command} -> ${result.stderr}`,
      ).toBe(command);
      expect(host.requests.length).toBeGreaterThan(0);
      for (const request of host.requests) {
        expect(request.path.startsWith(SESSION_BASE)).toBe(true);
      }
    }
  });
});

/**
 * The reader's follow-ups have to reach the CALLER, not just the response
 * body. `cctl conversation read` is where an agent meets a bounded window, so
 * its own default output is the surface that must name the omitted sequence,
 * the entry the cut landed inside, and every excerpt — otherwise the commands
 * exist and nobody is ever shown them.
 */
describe("conversation read prints the recovery commands it was given", () => {
  function entry(
    seq: number,
    role: "user" | "assistant",
    content: MessageContentBlock[],
  ): TranscriptEntryWithSeq {
    return {
      seq,
      entryId: null,
      role,
      timestamp: "2026-09-01T00:00:00.000Z",
      content,
    };
  }

  function renderTruncated() {
    const entries: TranscriptEntryWithSeq[] = [
      entry(0, "user", [{ type: "text", text: "start the work" }]),
      entry(1, "assistant", [
        { type: "tool_result", tool_use_id: "t1", content: "R".repeat(20_000) },
      ]),
      entry(2, "user", [{ type: "text", text: "and then this" }]),
      entry(3, "assistant", [{ type: "text", text: "done" }]),
    ];
    return renderCompactTranscript(
      { conversationId: "conv-1", entries, maxSeq: 3 },
      renderOptionsSchema.parse({ maxBytes: 400 }),
    );
  }

  function recoveryCommands(
    rendered: ReturnType<typeof renderTruncated>,
  ): string[] {
    return [
      rendered.truncation.omittedAfter?.command,
      rendered.truncation.partialEntry?.command,
      ...rendered.truncation.excerptedEntries.map((item) => item.command),
    ].filter((value): value is string => typeof value === "string");
  }

  it("names every omitted, partial and excerpted recovery in default output", async () => {
    const rendered = renderTruncated();
    const host = makeHost(() => jsonResponse(rendered));

    const read = await runCcWithHost(
      ["conversation", "read", "conv-1", "--max-bytes", "400"],
      sessionEnv,
      host,
    );

    expect(read.exitCode).toBe(0);
    const commands = recoveryCommands(rendered);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(read.stdout).toContain(command);
    }
    // The next raw sequence is a fact, not only a command argument.
    const omitted = rendered.truncation.omittedAfter;
    expect(omitted).not.toBeNull();
    expect(read.stdout).toContain(`seq ${omitted?.nextSeq}`);
  });

  it("runs the commands its own output printed", async () => {
    const rendered = renderTruncated();
    const readHost = makeHost(() => jsonResponse(rendered));
    const read = await runCcWithHost(
      ["conversation", "read", "conv-1", "--max-bytes", "400"],
      sessionEnv,
      readHost,
    );

    // Taken out of the CLI's rendered text, not out of the response body: a
    // command an agent cannot read is a command it cannot run.
    const printed = [
      ...read.stdout.matchAll(/cctl conversation (?:entry get|read) [^\n]+/gu),
    ].map((match) => match[0]);
    expect(printed.length).toBeGreaterThan(0);

    for (const command of printed) {
      const host = makeHost((req) =>
        req.path.includes("format=metadata")
          ? jsonResponse(entryMetadata())
          : req.path.includes("/history/entries/")
            ? textResponse("recovered entry")
            : jsonResponse({
                ...rendered,
                units: [],
                truncated: false,
                truncation: {
                  omittedAfter: null,
                  partialEntry: null,
                  excerptedEntries: [],
                  excerptedEntriesOmitted: 0,
                  excerptedEntriesNext: null,
                },
              }),
      );
      const result = await runCcWithHost(
        command.split(" ").slice(1),
        sessionEnv,
        host,
      );
      expect(result.exitCode).toBe(0);
      expect(host.requests.length).toBeGreaterThan(0);
    }
  });

  it("accounts for excerpts the server's own index capped", async () => {
    const rendered = renderTruncated();
    // The server caps its excerpt index at eight and reports the overflow with
    // a cursor; the CLI states that accounting rather than counting again.
    const excerpted = [
      {
        seq: 5,
        messageIndex: 2,
        elidedBytes: 1_200,
        command: "cctl conversation entry get conv-1 5",
      },
      {
        seq: 7,
        messageIndex: 3,
        elidedBytes: 900,
        command: "cctl conversation entry get conv-1 7",
      },
    ];
    const host = makeHost(() =>
      jsonResponse({
        ...rendered,
        truncation: {
          ...rendered.truncation,
          excerptedEntries: excerpted,
          excerptedEntriesOmitted: 4,
          excerptedEntriesNext: {
            nextSeq: 9,
            lastSeq: 21,
            command: "cctl conversation read conv-1 --seq-range 9:21",
          },
        },
      }),
    );

    const read = await runCcWithHost(
      ["conversation", "read", "conv-1", "--max-bytes", "400"],
      sessionEnv,
      host,
    );

    expect(read.stdout).toContain("4 excerpted entries omitted");
    expect(read.stdout).toContain("Excerpted entry seq 5");
    expect(read.stdout).toContain("Excerpted entry seq 7");
    expect(read.stdout).toContain(
      "cctl conversation read conv-1 --seq-range 9:21",
    );
    for (const entry of excerpted) {
      expect(read.stdout).toContain(entry.command);
      expect(read.stdout).toContain(`${entry.elidedBytes} bytes elided`);
    }
  });
});
