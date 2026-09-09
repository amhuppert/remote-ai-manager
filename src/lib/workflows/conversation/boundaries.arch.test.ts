import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(__dirname, "../../..");
const conversationRoot = "lib/workflows/conversation/";
const privateModules = new Set([
  "types",
  "machine",
  "actors",
  "actor-host",
  "actor-implementations",
  "runtime-state",
  "runtime-binding",
  "turn-attempt",
  "production",
]);

function forbiddenImports(source: string, file: string): string[] {
  const violations: string[] = [];
  function record(specifier: string, position: number) {
    const resolved = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? path.posix.normalize(
            path.posix.join(path.posix.dirname(file), specifier),
          )
        : path.isAbsolute(specifier)
          ? path.relative(sourceRoot, specifier)
          : null;
    if (resolved === null) return;
    const target = resolved.replace(/\.[cm]?[jt]sx?$/, "");
    const privateConversationImport =
      target.startsWith(conversationRoot) &&
      privateModules.has(target.slice(conversationRoot.length));
    let reason: string | undefined;
    if (!file.startsWith(conversationRoot) && privateConversationImport)
      reason = "conversation lifecycle internals require a semantic API";
    if (
      file.startsWith("lib/agent-backends/") &&
      target.startsWith(conversationRoot)
    )
      reason = "providers cannot own CC conversation lifecycle";
    if (
      file.startsWith("lib/workflows/debug/") &&
      target === "lib/prompt/sdk-driver"
    )
      reason = "debug policy cannot depend on prompt transport";
    if (
      file.startsWith("lib/workflow-graph/") &&
      ["lib/prompt/sdk-driver", "lib/prompt/route-handlers"].includes(target)
    )
      reason = "graph execution uses conversation admission and outcomes";
    if (reason)
      violations.push(
        `${file}:${source.slice(0, position).split("\n").length} ${reason}: ${specifier}`,
      );
  }

  for (const dependency of ts.preProcessFile(source, true, true)
    .importedFiles) {
    record(dependency.fileName, dependency.pos);
  }
  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "testing" ? [] : sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(test|stories)\.[cm]?[jt]sx?$/.test(file)
      ? [file]
      : [];
  });
}

describe("conversation lifecycle import boundaries", () => {
  it("detects static, reexported, dynamic, require and import-type dependencies", () => {
    const samples = [
      'import { getConversationRuntime } from "@/lib/workflows/conversation/runtime-state";',
      'export { createProvidedMachine } from "../workflows/conversation/actor-host.js";',
      'const implementation = import("@/lib/workflows/conversation/actor-implementations");',
      'const state = require("@/lib/workflows/conversation/runtime-binding");',
      'type Event = import("@/lib/workflows/conversation/types").ConversationEvent;',
    ];
    for (const source of samples)
      expect(
        forbiddenImports(source, "lib/conversations/consumer.ts"),
        source,
      ).toHaveLength(1);
  });
  it("keeps provider, debug and graph dependencies on their public boundaries", () => {
    expect(
      forbiddenImports(
        'import("@/lib/workflows/conversation/manager")',
        "lib/agent-backends/claude/conversation-runtime.ts",
      ),
    ).toHaveLength(1);
    expect(
      forbiddenImports(
        'require("@/lib/prompt/sdk-driver")',
        "lib/workflows/debug/prompt-policy.ts",
      ),
    ).toHaveLength(1);
    expect(
      forbiddenImports(
        'import { executePromptStream } from "@/lib/prompt/sdk-driver"',
        "lib/workflow-graph/implementer-runner.ts",
      ),
    ).toHaveLength(1);
  });
  it("allows semantic conversation APIs, feature results, descriptors and transcripts", () => {
    expect(
      forbiddenImports(
        'import { executeConversationTurn } from "@/lib/workflows/conversation/manager"; import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";',
        "lib/workflow-graph/validator-runner.ts",
      ),
    ).toEqual([]);
    expect(
      forbiddenImports(
        'import { getConversationRuntime } from "./runtime-state";',
        "lib/workflows/conversation/production.ts",
      ),
    ).toEqual([]);
    expect(
      forbiddenImports(
        'import type { ConversationTarget } from "@/lib/conversations/conversation-target"; import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";',
        "lib/agent-backends/claude/conversation-runtime.ts",
      ),
    ).toEqual([]);
  });
  it("audits every production source file", () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) =>
      forbiddenImports(
        readFileSync(file, "utf8"),
        path.relative(sourceRoot, file),
      ),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
