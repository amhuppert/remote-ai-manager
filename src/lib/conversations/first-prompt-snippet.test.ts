import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFirstPromptSnippet,
  _resetFirstPromptSnippetCache,
} from "./first-prompt-snippet";

let tmpDir: string;

beforeEach(async () => {
  _resetFirstPromptSnippetCache();
  tmpDir = await fsp.mkdtemp(join(tmpdir(), "first-prompt-snippet-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeTranscript(name: string, lines: string[]): Promise<string> {
  const path = join(tmpDir, `${name}.jsonl`);
  await fsp.writeFile(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

describe("getFirstPromptSnippet", () => {
  it("extracts text from the first user entry with array content", async () => {
    const path = await writeTranscript("a", [
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Hello world" }],
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("Hello world");
  });

  it("extracts text when content is a plain string", async () => {
    const path = await writeTranscript("b", [
      JSON.stringify({ role: "user", content: "Just a plain string" }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("Just a plain string");
  });

  it("joins multiple text blocks within a single entry with a space", async () => {
    const path = await writeTranscript("c", [
      JSON.stringify({
        role: "user",
        content: [
          { type: "text", text: "Part one" },
          { type: "text", text: "Part two" },
        ],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("Part one Part two");
  });

  it("skips assistant entries until the first user entry is found", async () => {
    const path = await writeTranscript("d", [
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "assistant first" }],
      }),
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "user second" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("user second");
  });

  it("returns null when no user entry exists", async () => {
    const path = await writeTranscript("e", [
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "only assistant" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBeNull();
  });

  it("returns null when the user entry has no text block", async () => {
    const path = await writeTranscript("f", [
      JSON.stringify({
        role: "user",
        content: [{ type: "tool_use", name: "Read", id: "x" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    expect(
      await getFirstPromptSnippet(join(tmpDir, "does-not-exist.jsonl")),
    ).toBeNull();
  });

  it("skips malformed JSON lines and continues searching", async () => {
    const path = await writeTranscript("g", [
      "not valid json",
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "after the garbage" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("after the garbage");
  });

  it("flattens newlines and tabs in extracted text", async () => {
    const path = await writeTranscript("h", [
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "line one\n\tline two\n\nline three" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe(
      "line one line two line three",
    );
  });

  it("truncates very long text to 120 characters with ellipsis", async () => {
    const longText = "a".repeat(200);
    const path = await writeTranscript("i", [
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: longText }],
      }),
    ]);
    const snippet = await getFirstPromptSnippet(path);
    expect(snippet).not.toBeNull();
    expect(snippet!.length).toBe(121);
    expect(snippet!.endsWith("…")).toBe(true);
    expect(snippet!.slice(0, 120)).toBe("a".repeat(120));
  });

  it("returns cached value when mtime is unchanged", async () => {
    const path = await writeTranscript("j", [
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "original" }],
      }),
    ]);
    // Pin mtime to a fixed instant so the rewrite below can restore it byte-for-byte.
    const fixedMtime = new Date("2023-01-01T00:00:00.000Z");
    await fsp.utimes(path, fixedMtime, fixedMtime);

    expect(await getFirstPromptSnippet(path)).toBe("original");

    await fsp.writeFile(
      path,
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "MUTATED" }],
      }) + "\n",
      "utf-8",
    );
    await fsp.utimes(path, fixedMtime, fixedMtime);

    expect(await getFirstPromptSnippet(path)).toBe("original");
  });

  it("re-reads the file when mtime changes", async () => {
    const path = await writeTranscript("k", [
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "first version" }],
      }),
    ]);
    expect(await getFirstPromptSnippet(path)).toBe("first version");

    // Forward the mtime to invalidate the cache.
    const future = new Date(Date.now() + 60_000);
    await fsp.writeFile(
      path,
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "second version" }],
      }) + "\n",
      "utf-8",
    );
    await fsp.utimes(path, future, future);

    expect(await getFirstPromptSnippet(path)).toBe("second version");
  });
});
