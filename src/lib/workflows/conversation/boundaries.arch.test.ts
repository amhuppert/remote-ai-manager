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
  "checkpoint-maintenance",
  "checkpoint-restart",
  "checkpoint-queue-repair",
]);

function forbiddenImports(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  function record(node: ts.StringLiteralLike) {
    const specifier = node.text;
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
        `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${reason}: ${specifier}`,
      );
  }
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      record(node.moduleSpecifier);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) record(argument);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      record(node.argument.literal);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

/**
 * Only the manager sends the checkpoint projection to an actor; the machine
 * handles it and the event union names it. Any other sender would be a second
 * lifecycle owner able to fake, drop or release a hold, so the event name may
 * not appear as a string literal anywhere else.
 */
const checkpointEventOwners = new Set(
  ["manager", "machine", "types"].map((name) => conversationRoot + name),
);
const CHECKPOINT_EVENT = "CHECKPOINT_PHASE";

function forbiddenCheckpointEvents(source: string, file: string): string[] {
  if (checkpointEventOwners.has(file.replace(/\.[cm]?[jt]sx?$/, ""))) return [];
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && node.text === CHECKPOINT_EVENT)
      violations.push(
        `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1} checkpoint actor events belong to the conversation manager: ${CHECKPOINT_EVENT}`,
      );
    ts.forEachChild(node, visit);
  }
  visit(parsed);
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
      'import { runCheckpointMaintenance } from "@/lib/workflows/conversation/checkpoint-maintenance";',
      'import { hydrateCheckpointAuthority } from "@/lib/workflows/conversation/checkpoint-restart";',
      'import { repairQueuedAcceptanceFromCheckpoint } from "@/lib/workflows/conversation/checkpoint-queue-repair";',
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
    const violations = sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(sourceRoot, file);
      return [
        ...forbiddenImports(source, relative),
        ...forbiddenCheckpointEvents(source, relative),
      ];
    });
    expect(violations, violations.join("\n")).toEqual([]);
  }, 30_000);
});

describe("checkpoint actor event ownership", () => {
  const send = 'actor.send({ type: "CHECKPOINT_PHASE", checkpoint: null });';
  it("refuses the projection event outside the manager, machine and event union", () => {
    for (const file of [
      "lib/conversations/consumer.ts",
      "lib/workflows/conversation/checkpoint-maintenance.ts",
      "lib/workflows/conversation/actor-host.ts",
    ])
      expect(forbiddenCheckpointEvents(send, file), file).toHaveLength(1);
    expect(
      forbiddenCheckpointEvents(
        'type Projection = { type: "CHECKPOINT_PHASE" }; const name = `CHECKPOINT_PHASE`;',
        "lib/workflows/conversation/rehydration.ts",
      ),
    ).toHaveLength(2);
  });
  it("allows its owners, and identifiers that merely contain the name", () => {
    for (const file of [
      "lib/workflows/conversation/manager.ts",
      "lib/workflows/conversation/machine.ts",
      "lib/workflows/conversation/types.ts",
    ])
      expect(forbiddenCheckpointEvents(send, file), file).toEqual([]);
    expect(
      forbiddenCheckpointEvents(
        'import { ACTIVE_CHECKPOINT_PHASES } from "@/lib/conversation-checkpoints/schemas"; const phases = ACTIVE_CHECKPOINT_PHASES;',
        "lib/conversations/consumer.ts",
      ),
    ).toEqual([]);
  });
});
