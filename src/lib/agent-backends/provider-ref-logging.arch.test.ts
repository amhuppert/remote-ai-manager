import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * No adapter log line may carry a raw provider continuation reference.
 *
 * A Claude session id or a Codex thread id addresses the provider-side
 * conversation. The workflow charter's `public-receipts-only` invariant keeps
 * those references in the conversation row and in protected evidence; the log
 * tree is an ordinary-permission public surface that operators read, copy and
 * attach to reports.
 *
 * This is written as a source rule rather than an assertion about today's
 * runtimes because the failure it guards is a one-word addition: every adapter
 * already holds the reference in a local named `threadId` or `sessionId`, and
 * dropping that name into the neighbouring log call is the natural next edit.
 * A behavioural test would cover the turn paths that exist now, not the one
 * someone adds later.
 */

const ADAPTER_ROOT = path.join(process.cwd(), "src", "lib", "agent-backends");

/** Locals that hold a raw provider reference in the adapters. */
const RAW_REF_FIELD = /^\s*(threadId|sessionId)\s*(,|:\s*[^,]+,)\s*$/;

function adapterSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts") || full.includes(".test.")) continue;
      files.push(full);
    }
  };
  walk(ADAPTER_ROOT);
  return files;
}

/**
 * The field object of every `logger.*` call, as raw lines.
 *
 * Adapters write these calls as a literal object argument, so reading forward
 * to the closing `});` is enough; anything that stops matching that shape
 * shows up as an unscanned call rather than a silent pass.
 */
function loggerCallFields(source: string): { event: string; body: string }[] {
  const lines = source.split("\n");
  const calls: { event: string; body: string }[] = [];
  lines.forEach((line, index) => {
    const opened = /logger\.(?:info|debug|warn|error)\("([^"]+)"/.exec(line);
    if (!opened) return;
    // A single-line call carries its fields on the call line itself; split them
    // out so a one-line log is scanned exactly like a multi-line one.
    const body: string[] = line
      .slice(opened.index + opened[0].length)
      .split(",")
      .map((field) => `  ${field.replace(/[{}();]/g, "").trim()},`);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? "";
      if (/^\s*\}\);/.test(current)) break;
      body.push(current);
    }
    calls.push({ event: opened[1] ?? "", body: body.join("\n") });
  });
  return calls;
}

describe("adapter logging", () => {
  it("never logs a raw provider continuation reference", () => {
    const offenders: string[] = [];
    for (const file of adapterSources()) {
      for (const call of loggerCallFields(readFileSync(file, "utf-8"))) {
        for (const field of call.body.split("\n")) {
          if (RAW_REF_FIELD.test(field)) {
            offenders.push(
              `${path.relative(process.cwd(), file)} — ${call.event} logs ${field.trim()}`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      "log a providerRefDigest(...) instead — see @/lib/agent-backends/provider-ref-digest",
    ).toEqual([]);
  });
});
