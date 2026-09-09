import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * History reading must have NO model-context effect.
 *
 * Viewing an artifact, expanding a tool result, or opening an image is
 * evidence retrieval, not a turn: a browse that quietly admitted a turn or
 * enqueued a prompt would change the conversation the operator was inspecting.
 * Enforced structurally as well as behaviourally, because the failure mode is a
 * convenient import added later rather than a wrong assertion today.
 *
 * The rule is an ALLOWLIST of module dependencies. A denylist of today's
 * submission modules would pass the moment someone routed through a new one;
 * an allowlist forces any new dependency of a history module to be argued for
 * here first.
 */

const HISTORY_MODULES = [
  "history-recovery.ts",
  "history-entry-service.ts",
  "history-image-service.ts",
  "transcript-render.ts",
  "transcript-logical-units.ts",
] as const;

/**
 * The HTTP surface over those readers. Held to the same rule with a widened
 * allowlist: a route handler legitimately needs auth, addressing and response
 * plumbing that a pure projection does not, and keeping that widening in its
 * own set is what stops the reader modules from inheriting it.
 */
const HISTORY_ROUTE_MODULES = [
  "history-route-handlers.ts",
  "scoped-route-target.ts",
] as const;

/**
 * Every module a history reader may depend on. All are pure projections,
 * schemas, or archive readers — none admits a turn, submits a prompt, or
 * touches a runtime.
 */
const ALLOWED_IMPORTS = new Set([
  "node:crypto",
  "node:path",
  "zod",
  "@/lib/commands/parsing",
  "@/lib/conversations/history-entry-service",
  "@/lib/conversations/history-recovery",
  "@/lib/conversations/message-content-schemas",
  "@/lib/conversations/schemas",
  "@/lib/conversations/transcript-logical-units",
  "@/lib/conversations/transcript-render",
  "@/lib/images/transcript-images",
  "@/lib/prompt/transcript",
  "@/lib/shared/truncate",
]);

/**
 * Route plumbing on top of `ALLOWED_IMPORTS`: token validation, the shared
 * scoped 404 ladder, structured logging, and the conversation-row reads that
 * ladder performs. Every one is a read or a response builder — none admits a
 * turn, enqueues a message, or reaches a runtime.
 */
const ROUTE_ALLOWED_IMPORTS = new Set([
  ...ALLOWED_IMPORTS,
  "next/server",
  "@/lib/agent-gateway/token",
  "@/lib/conversations/conversation-target",
  "@/lib/conversations/history-image-service",
  "@/lib/conversations/route-resolution",
  "@/lib/conversations/scoped-route-target",
  "@/lib/logging",
  "@/lib/projects/resolver",
  "@/lib/shared/route-resolution",
  "@/lib/state-store",
]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;

function importsOf(moduleFile: string): string[] {
  const source = readFileSync(path.join(__dirname, moduleFile), "utf-8");
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    // Relative sibling imports resolve into this same directory.
    found.push(
      specifier.startsWith("./")
        ? `@/lib/conversations/${specifier.slice(2)}`
        : specifier,
    );
  }
  return found;
}

describe("history reading has no provider effect", () => {
  for (const moduleFile of HISTORY_MODULES) {
    it(`${moduleFile} depends only on archive projections`, () => {
      const unexpected = importsOf(moduleFile).filter(
        (specifier) => !ALLOWED_IMPORTS.has(specifier),
      );
      expect(unexpected).toEqual([]);
    });
  }

  for (const moduleFile of HISTORY_ROUTE_MODULES) {
    it(`${moduleFile} depends only on archive projections and route plumbing`, () => {
      const unexpected = importsOf(moduleFile).filter(
        (specifier) => !ROUTE_ALLOWED_IMPORTS.has(specifier),
      );
      expect(unexpected).toEqual([]);
    });
  }

  it("names no prompt submission, queue, or runtime entry point", () => {
    const forbidden = [
      "enqueueQueuedMessage",
      "assembleTurnPrompt",
      "submitPrompt",
      "drainQueue",
      "createConversationManager",
      "ensureActor",
    ];
    for (const moduleFile of [...HISTORY_MODULES, ...HISTORY_ROUTE_MODULES]) {
      const source = readFileSync(path.join(__dirname, moduleFile), "utf-8");
      for (const symbol of forbidden) {
        expect(source, `${moduleFile} references ${symbol}`).not.toContain(
          symbol,
        );
      }
    }
  });
});
