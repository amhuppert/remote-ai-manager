/**
 * In-memory cached extraction of a conversation's first user-message text.
 *
 * Cache key is the transcript path; the cached value carries the mtimeMs the
 * snippet was extracted at. A stat() before each read invalidates the entry
 * when the transcript has been written to (new turns appended), so live
 * sessions reflect updates without bypassing the cache for cold reads.
 */

import { promises as fsp, createReadStream } from "node:fs";
import readline from "node:readline";
import { createLogger } from "@/lib/logging";
import { truncate } from "@/lib/shared/truncate";

const log = createLogger("conversations:first-prompt-snippet");

const SNIPPET_MAX_LENGTH = 120;

interface CacheEntry {
  mtimeMs: number;
  snippet: string | null;
}

const cache = new Map<string, CacheEntry>();

export async function getFirstPromptSnippet(
  transcriptPath: string,
): Promise<string | null> {
  let mtimeMs: number;
  try {
    const stat = await fsp.stat(transcriptPath);
    mtimeMs = stat.mtimeMs;
  } catch (err) {
    log.warn("transcript stat failed", { transcriptPath, err: String(err) });
    return null;
  }

  const cached = cache.get(transcriptPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.snippet;
  }

  const snippet = await readFirstUserSnippet(transcriptPath);
  cache.set(transcriptPath, { mtimeMs, snippet });
  return snippet;
}

async function readFirstUserSnippet(
  transcriptPath: string,
): Promise<string | null> {
  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    stream = createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.trim().length === 0) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const text = extractUserText(entry);
        if (text !== null) {
          return truncate(flatten(text), SNIPPET_MAX_LENGTH);
        }
      }
      return null;
    } finally {
      rl.close();
    }
  } catch (err) {
    log.warn("transcript read failed", { transcriptPath, err: String(err) });
    return null;
  } finally {
    stream?.destroy();
  }
}

function extractUserText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const obj = entry as Record<string, unknown>;
  if (obj.role !== "user") return null;

  const content = obj.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    if (texts.length > 0) return texts.join(" ");
  }
  return null;
}

function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function _resetFirstPromptSnippetCache(): void {
  cache.clear();
}
