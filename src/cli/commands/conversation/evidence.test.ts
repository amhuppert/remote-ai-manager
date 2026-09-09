import { describe, expect, it } from "vitest";

import { renderCompactTranscript } from "@/lib/conversations/transcript-render";
import { renderOptionsSchema } from "@/lib/conversations/transcript-render";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import { runCli } from "../../core";
import { STDOUT_BUDGET_BYTES } from "../../disclosure";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

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

const projectEnv: CliEnv = {
  ...sessionEnv,
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
};

const SESSION_BASE =
  "/api/projects/cc/sessions/my-session/conversations/conv-1";
const PROJECT_BASE = "/api/projects/cc/conversations/conv-1";

interface RecordedRequest {
  path: string;
  method: string;
}

interface TestHost extends CliHost {
  requests: RecordedRequest[];
  written: { path: string; content: string }[];
  writtenBytes: { path: string; bytes: Uint8Array }[];
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

function makeHost(
  respond: (req: RecordedRequest) => Response,
  options: {
    writeTextFile?: CliHost["writeTextFile"];
    writeFileBytes?: CliHost["writeFileBytes"];
  } = {},
): TestHost {
  const requests: RecordedRequest[] = [];
  const written: { path: string; content: string }[] = [];
  const writtenBytes: { path: string; bytes: Uint8Array }[] = [];
  return {
    requests,
    written,
    writtenBytes,
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
    writeTextFile:
      options.writeTextFile ??
      (async (path: string, content: string) => {
        written.push({ path, content });
      }),
    writeFileBytes:
      options.writeFileBytes ??
      (async (path: string, bytes: Uint8Array) => {
        writtenBytes.push({ path, bytes });
      }),
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

const IMAGE_HANDLE = {
  conversationId: "conv-1",
  seq: 148,
  contentBlockIndex: 2,
  mediaType: "image/png",
  storage: "external",
  command: "cctl conversation image get conv-1 148 2",
};

function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("cctl conversation entry get", () => {
  it("exports the complete entry with its measurements and image handles", async () => {
    const body = "⚙ Bash(ls)\nfull tool result, unexcerpted";
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(entryMetadata({ images: [IMAGE_HANDLE] }))
        : textResponse(body),
    );

    const result = await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests.map((r) => r.path)).toEqual([
      `${SESSION_BASE}/history/entries/148?format=metadata`,
      `${SESSION_BASE}/history/entries/148`,
    ]);
    expect(result.stdout).toContain("entry seq 148");
    expect(result.stdout).toContain("sha256: entry-hash");
    expect(result.stdout).toContain("full tool result, unexcerpted");
    // The image handle carries its own ready-to-run command, so the block index
    // is never something a caller counts by eye.
    expect(result.stdout).toContain("cctl conversation image get conv-1 148 2");
  });

  it("reports omitted thinking and opts in on request", async () => {
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(
            entryMetadata(
              req.path.includes("includeThinking=true")
                ? { includeThinking: true, thinkingOmitted: 0 }
                : {},
            ),
          )
        : textResponse("body"),
    );

    const without = await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      sessionEnv,
      host,
    );
    expect(without.stdout).toContain("omitted (2 block(s))");

    const withThinking = await runCli(
      ["conversation", "entry", "get", "conv-1", "148", "--include-thinking"],
      sessionEnv,
      host,
    );
    expect(withThinking.stdout).toContain("thinking: included");
    expect(host.requests.at(-1)?.path).toBe(
      `${SESSION_BASE}/history/entries/148?includeThinking=true`,
    );
  });

  it("selects the same content in text and JSON", async () => {
    const body = "the exported entry text";
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(entryMetadata())
        : textResponse(body),
    );

    const text = await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      sessionEnv,
      host,
    );
    const json = await runCli(
      ["conversation", "entry", "get", "conv-1", "148", "--json"],
      sessionEnv,
      host,
    );

    expect(text.stdout).toContain(body);
    expect(envelope(json.stdout).text).toBe(body);
    expect((envelope(json.stdout).entry as { seq: number }).seq).toBe(148);
  });

  it("round-trips a huge tool result through a .cc/temp export", async () => {
    const huge = `TOOL-RESULT-START\n${"x".repeat(200_000)}\nTOOL-RESULT-END`;
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(entryMetadata({ bytes: huge.length }))
        : textResponse(huge),
    );

    const result = await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("TOOL-RESULT-START");
    expect(result.stdout).toContain(".cc/temp/");
    expect(result.stdout).toContain("sha256: sha256:");
    // The receipt says how to read the file back without re-flooding a
    // context, and says it in BYTES. This export is three lines long, so a
    // line-ranged instruction such as `sed -n '1,200p'` would print all
    // 200,000 characters — the exact flood the spill exists to prevent.
    const spilledBytes = Buffer.byteLength(
      host.written[0]?.content ?? "",
      "utf8",
    );
    const chunk = /head -c (\d+) /u.exec(result.stdout);
    expect(chunk).not.toBeNull();
    expect(Number(chunk?.[1])).toBeLessThan(spilledBytes);
    expect(result.stdout).toContain(
      `head -c ${chunk?.[1]} ${host.written[0]?.path}`,
    );
    expect(result.stdout).not.toContain("sed -n");
    expect(result.stdout).toContain(
      `bytes: ${Buffer.byteLength(host.written[0]?.content ?? "", "utf8")}`,
    );
    expect(host.written).toHaveLength(1);
    // The spill preserves the COMPLETE export, not a shortened one.
    expect(host.written[0]?.content).toContain(huge);
  });

  it("fails typed and bounded when the export cannot be written", async () => {
    const huge = "y".repeat(200_000);
    const host = makeHost(
      (req) =>
        req.path.includes("format=metadata")
          ? jsonResponse(entryMetadata())
          : textResponse(huge),
      {
        writeTextFile: async () => {
          throw new Error("EACCES");
        },
      },
    );

    const result = await runCli(
      ["conversation", "entry", "get", "conv-1", "148", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).code).toBe("write_failed");
    expect(result.stdout).not.toContain(huge);
  });

  it("refuses a non-integer coordinate locally, before any request", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["conversation", "entry", "get", "conv-1", "#12"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
    expect(result.stderr).toContain("message indexes");
  });

  it("separates a missing coordinate from a line it cannot project", async () => {
    const notFound = makeHost(() =>
      jsonResponse(
        {
          error: "no archive line at this sequence",
          code: "entry_not_found",
          seq: 9999,
        },
        404,
      ),
    );
    const missing = await runCli(
      ["conversation", "entry", "get", "conv-1", "9999"],
      sessionEnv,
      notFound,
    );
    expect(missing.exitCode).toBe(2);

    const unsupported = makeHost(() =>
      jsonResponse(
        {
          error: "the adapter does not project this line",
          code: "entry_unsupported",
          seq: 3,
        },
        422,
      ),
    );
    const refused = await runCli(
      ["conversation", "entry", "get", "conv-1", "3"],
      sessionEnv,
      unsupported,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("does not project");
  });

  it("serves a project conversation at its own address", async () => {
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(entryMetadata())
        : textResponse("body"),
    );
    await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      projectEnv,
      host,
    );
    expect(host.requests[0]?.path).toBe(
      `${PROJECT_BASE}/history/entries/148?format=metadata`,
    );
  });
});

describe("cctl conversation image get", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00]);

  function imageHost(
    options: { writeFileBytes?: CliHost["writeFileBytes"] } = {},
  ) {
    return makeHost(
      () =>
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      options,
    );
  }

  it("writes the original bytes under .cc/temp and reports path, type and hash", async () => {
    const host = imageHost();
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.path).toBe(`${SESSION_BASE}/history/images/148/2`);
    const json = envelope(result.stdout);
    const artifact = json.artifact as {
      path: string;
      bytes: number;
      sha256: string;
    };
    expect(artifact.path.startsWith(".cc/temp/")).toBe(true);
    expect(artifact.bytes).toBe(PNG_BYTES.byteLength);
    expect(artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect((json.image as { mediaType: string }).mediaType).toBe("image/png");

    // The bytes reach the file unchanged; stdout carries no base64 of them.
    expect(host.writtenBytes).toHaveLength(1);
    expect([...(host.writtenBytes[0]?.bytes ?? [])]).toEqual([...PNG_BYTES]);
    expect(result.stdout).not.toContain(
      Buffer.from(PNG_BYTES).toString("base64"),
    );
  });

  it("recovers the same bytes for a project conversation", async () => {
    const host = imageHost();
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2"],
      projectEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.path).toBe(`${PROJECT_BASE}/history/images/148/2`);
    expect([...(host.writtenBytes[0]?.bytes ?? [])]).toEqual([...PNG_BYTES]);
  });

  it("reports a missing asset while keeping its handle", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "the archive no longer holds these bytes",
          code: "asset_unavailable",
          requested: { seq: 148, contentBlockIndex: 2 },
          handle: IMAGE_HANDLE,
        },
        404,
      ),
    );

    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const json = envelope(result.stdout);
    expect(json.code).toBe("asset_unavailable");
    expect(host.writtenBytes).toHaveLength(0);
  });

  it("names the materialized file by its media type so a viewer opens it", async () => {
    const host = imageHost();
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2", "--json"],
      sessionEnv,
      host,
    );

    const artifact = envelope(result.stdout).artifact as { path: string };
    expect(artifact.path.endsWith(".png")).toBe(true);
    expect(host.writtenBytes[0]?.path).toBe(artifact.path);
  });

  it("reports the media type essence and its extension for a parameterised type", async () => {
    const host = makeHost(
      () =>
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/jpeg; charset=binary" },
        }),
    );
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2", "--json"],
      sessionEnv,
      host,
    );

    const json = envelope(result.stdout);
    expect((json.image as { mediaType: string }).mediaType).toBe("image/jpeg");
    expect((json.artifact as { path: string }).path.endsWith(".jpg")).toBe(
      true,
    );
  });

  it("refuses a non-integer block index locally", async () => {
    const host = imageHost();
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "last"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("fails typed when the image file cannot be written", async () => {
    const host = imageHost({
      writeFileBytes: async () => {
        throw new Error("EACCES");
      },
    });
    const result = await runCli(
      ["conversation", "image", "get", "conv-1", "148", "2", "--json"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).code).toBe("write_failed");
  });
});

/**
 * The budget is a property of the SERIALIZED output, so these drive it to the
 * exact byte. `emitLarge` spills at the budget and stays inline below it, and
 * the boundary is measured against `Buffer.byteLength`, never a character
 * count — a multibyte export whose code points fit would otherwise overrun the
 * pipe by a factor of its encoding width.
 */
describe("the shared stdout budget is measured on the final serialization", () => {
  async function exportOf(body: string) {
    const host = makeHost((req) =>
      req.path.includes("format=metadata")
        ? jsonResponse(entryMetadata())
        : textResponse(body),
    );
    const result = await runCli(
      ["conversation", "entry", "get", "conv-1", "148"],
      sessionEnv,
      host,
    );
    return { result, host };
  }

  /** Serialized bytes this command emits around a body of `probe` bytes. */
  async function overheadBytes(probe: string): Promise<number> {
    const { result } = await exportOf(probe);
    return (
      Buffer.byteLength(result.stdout, "utf8") -
      Buffer.byteLength(probe, "utf8")
    );
  }

  it("stays inline one byte under the budget and spills at it", async () => {
    const overhead = await overheadBytes("A");

    const under = await exportOf(
      "A".repeat(STDOUT_BUDGET_BYTES - overhead - 1),
    );
    expect(Buffer.byteLength(under.result.stdout, "utf8")).toBe(
      STDOUT_BUDGET_BYTES - 1,
    );
    expect(under.host.written).toHaveLength(0);

    const at = await exportOf("A".repeat(STDOUT_BUDGET_BYTES - overhead));
    expect(at.host.written).toHaveLength(1);
    expect(Buffer.byteLength(at.result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(Buffer.byteLength(at.host.written[0]?.content ?? "", "utf8")).toBe(
      STDOUT_BUDGET_BYTES,
    );
  });

  it("counts UTF-8 bytes rather than code points", async () => {
    // U+2603 is three UTF-8 bytes, so the spilling export is barely a third of
    // the budget in characters.
    const overhead = await overheadBytes("\u2603");
    const room = STDOUT_BUDGET_BYTES - overhead;
    // ASCII filler absorbs the remainder so the snowmen land on the byte.
    const pad = "A".repeat(room % 3);
    const chars = (room - pad.length) / 3;
    const body = (count: number) => `${pad}${"\u2603".repeat(count)}`;

    const at = await exportOf(body(chars));
    expect(at.host.written).toHaveLength(1);
    expect(Buffer.byteLength(at.host.written[0]?.content ?? "", "utf8")).toBe(
      STDOUT_BUDGET_BYTES,
    );
    // A third of the budget in characters, all of it in bytes.
    expect(body(chars).length).toBeLessThan(STDOUT_BUDGET_BYTES / 2);

    const under = await exportOf(body(chars - 1));
    expect(under.host.written).toHaveLength(0);
    expect(Buffer.byteLength(under.result.stdout, "utf8")).toBe(
      STDOUT_BUDGET_BYTES - 3,
    );
  });
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

      const result = await runCli(argvOf(entry.command), sessionEnv, host);

      expect(result.exitCode).toBe(0);
      expect(host.requests[0]?.path).toBe(
        `${SESSION_BASE}/history/entries/${entry.seq}?format=metadata`,
      );
      // Inline under the budget, in the spill file past it — either way the
      // export is the complete entry, not the excerpt the reader showed.
      const disclosed = [result.stdout, ...host.written.map((f) => f.content)];
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
    await runCli(argvOf(omitted.command), sessionEnv, host);

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
                totalMessages: 4,
                maxSeq: 3,
                units: [],
                truncated: false,
              }),
      );

      const result = await runCli(argvOf(command), sessionEnv, host);
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

    const read = await runCli(
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
    const read = await runCli(
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
      const result = await runCli(
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

    const read = await runCli(
      ["conversation", "read", "conv-1", "--max-bytes", "400"],
      sessionEnv,
      host,
    );

    expect(read.stdout).toContain("6 total, 2 shown");
    expect(read.stdout).toContain(
      "cctl conversation read conv-1 --seq-range 9:21",
    );
    for (const entry of excerpted) {
      expect(read.stdout).toContain(entry.command);
      expect(read.stdout).toContain(`${entry.elidedBytes} bytes elided`);
    }
  });
});
