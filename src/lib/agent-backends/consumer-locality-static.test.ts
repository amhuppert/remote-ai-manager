/**
 * Consumer-locality static half (design Blocker 4, D-B4.4).
 *
 * Corpus E — the execution-consumer modules that must need ZERO edits when a
 * new backend is added — is pinned here with a per-file enforcement status.
 * For every `enforced` file the source contains zero backend-id literals and
 * zero provider-identity comparisons (no allowlist: a log line that needs the
 * backend uses the variable, comments included by design — accepted cost).
 * Equality between two opaque backend variables is parametric ownership
 * validation and is intentionally allowed: it cannot select a provider path.
 * Every `pending:phase-3` file pins its EXACT current literal/comparison
 * counts: when the owning Phase 3 slice cleans lines the pin fails downward
 * and the entry must be ratcheted (or flipped to `enforced` at zero) in the
 * same PR, while a NEW literal/comparison fails the pin upward as a
 * regression — an unrelated change can never keep a stale entry green.
 * Phase 3's exit criterion: zero `pending:phase-3` entries remaining in the
 * locality suites.
 *
 * Explicitly exempt from corpus E: `src/lib/agent-backends/**` (adding a
 * backend IS edits there), `shared/schemas.ts` (allowed edit #1),
 * `agent-capabilities/{claude,codex}-discovery.ts` (backend-owned discovery
 * providers behind the explicit discovery interface), `workflows/collaboration/**`
 * (the Claude/Codex pair is named config per P10), and UI catalog consumers
 * (they render from the backend catalog).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LIB_ROOT = path.resolve(__dirname, "..");

export interface PendingLocalityPin {
  /** Exact `["'`](claude|codex)["'`]` match count observed today. */
  literals: number;
  /** Exact provider-literal identity comparison count observed today. */
  comparisons: number;
}

export type ConsumerLocalityEntry =
  | {
      /** Repo-relative path under `src/lib/`. */
      file: string;
      /** Corpus E category from the design's table. */
      category: "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7";
      status: "enforced";
    }
  | {
      file: string;
      category: "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7";
      status: "pending:phase-3";
      pin: PendingLocalityPin;
    };

export const CONSUMER_LOCALITY_MAP: readonly ConsumerLocalityEntry[] = [
  // E1 — AgentCall
  {
    file: "workflows/primitives/agent-call-facade.ts",
    category: "E1",
    status: "enforced",
  },
  {
    file: "workflows/primitives/agent-call-conversation.ts",
    category: "E1",
    status: "enforced",
  },
  {
    file: "workflows/primitives/agent-call-task.ts",
    category: "E1",
    status: "enforced",
  },
  {
    file: "workflows/primitives/agent-call-vocabulary.ts",
    category: "E1",
    status: "enforced",
  },
  {
    file: "workflows/primitives/backend-capabilities.ts",
    category: "E1",
    status: "enforced",
  },
  // E2 — Machines
  {
    file: "workflows/conversation/machine.ts",
    category: "E2",
    status: "enforced",
  },
  {
    file: "workflows/conversation/actor-implementations.ts",
    category: "E2",
    status: "enforced",
  },
  {
    file: "workflows/conversation/pre-turn/resolve-model-effort.ts",
    category: "E2",
    status: "enforced",
  },
  {
    file: "workflows/conversation/pre-turn/capability-cascade.ts",
    category: "E2",
    status: "enforced",
  },
  {
    file: "workflows/conversation/pre-turn/fork-seed.ts",
    category: "E2",
    status: "enforced",
  },
  {
    file: "workflows/conversation/execute-workflow-task-run.ts",
    category: "E2",
    status: "enforced",
  },
  // E3 — Lane modules + gates (provider-named deps die in 3.2)
  {
    file: "workflows/primitives/workflow-agent-caller.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflows/primitives/lane-service.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflows/primitives/lane-store.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflows/primitives/lane-scheduler.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflows/primitives/lane-vocabulary.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflow-graph/graph-lane-store.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflow-graph/lane-continuity.ts",
    category: "E3",
    status: "enforced",
  },
  {
    file: "workflows/primitives/context-limit-gate.ts",
    category: "E3",
    status: "enforced",
  },
  // E4 — Transcript consumers
  {
    file: "workflow-graph/execution-logger.ts",
    category: "E4",
    status: "enforced",
  },
  {
    file: "workflow-graph/validator-runner.ts",
    category: "E4",
    status: "enforced",
  },
  {
    file: "workflows/conversation/types.ts",
    category: "E4",
    status: "enforced",
  },
  // E5 — MCP apply (disposition derives from the descriptor's betweenTurnApply)
  { file: "mcp/runtime-apply.ts", category: "E5", status: "enforced" },
  // E6 — Orchestration (graph runners migrate in 3.2/3.3; conversations/service
  // fork is behaviorally enforced from 1.6 but the file still carries
  // default-backend literals)
  {
    file: "workflow-graph/iteration-orchestrator.ts",
    category: "E6",
    status: "enforced",
  },
  {
    file: "workflow-graph/implementer-runner.ts",
    category: "E6",
    status: "enforced",
  },
  {
    file: "workflow-graph/workflow-collaborator-caller.ts",
    category: "E6",
    status: "enforced",
  },
  {
    file: "workflow-graph/execution-events.ts",
    category: "E6",
    status: "enforced",
  },
  {
    file: "workflow-graph/execution-tool-context.ts",
    category: "E6",
    status: "enforced",
  },
  { file: "prompt/sdk-driver.ts", category: "E6", status: "enforced" },
  { file: "conversations/service.ts", category: "E6", status: "enforced" },
  { file: "agent-runs/service.ts", category: "E6", status: "enforced" },
  // E7 — Conversation-start capability composition (cascade taxonomy derives
  // from descriptor capabilityKinds; discovery selection goes through the
  // explicit per-cascade provider interface)
  {
    file: "agent-capabilities/runtime-composer.ts",
    category: "E7",
    status: "enforced",
  },
  {
    file: "agent-capabilities/default-deps.ts",
    category: "E7",
    status: "enforced",
  },
];

/** D-B4.4's two scan regexes — literals and provider comparisons. */
const BACKEND_ID_LITERAL = /["'`](claude|codex)["'`]/g;
const BACKEND_IDENTITY_COMPARISON =
  /\b(?:backend|agentBackend)\s*===\s*["'`](?:claude|codex)["'`]/g;

function scanSource(source: string): {
  literalMatches: string[];
  comparisonMatches: string[];
} {
  return {
    literalMatches: [...source.matchAll(BACKEND_ID_LITERAL)].map((m) => m[0]),
    comparisonMatches: [...source.matchAll(BACKEND_IDENTITY_COMPARISON)].map(
      (m) => m[0],
    ),
  };
}

function readCorpusFile(relFile: string): string {
  return readFileSync(path.join(LIB_ROOT, relFile), "utf8");
}

describe("consumer-locality static half: corpus E backend-id scan", () => {
  for (const entry of CONSUMER_LOCALITY_MAP) {
    if (entry.status === "enforced") {
      it(`[${entry.category}] ${entry.file} contains zero backend-id literals and identity comparisons`, () => {
        const { literalMatches, comparisonMatches } = scanSource(
          readCorpusFile(entry.file),
        );
        expect(literalMatches).toEqual([]);
        expect(comparisonMatches).toEqual([]);
      });
    } else {
      // Exact pin of today's blocking counts. A decrease means a Phase 3
      // slice cleaned lines: ratchet the pin down (flip to `enforced` at
      // zero) in the same PR. An increase is a locality regression.
      it(`[${entry.category}] ${entry.file} carries exactly its pinned backend-id counts (staged to Phase 3)`, () => {
        const { literalMatches, comparisonMatches } = scanSource(
          readCorpusFile(entry.file),
        );
        expect(
          {
            literals: literalMatches.length,
            comparisons: comparisonMatches.length,
          },
          `pinned counts for ${entry.file} drifted.\n` +
            `observed literals: ${literalMatches.join(", ") || "(none)"}\n` +
            `observed comparisons: ${comparisonMatches.join(", ") || "(none)"}\n` +
            `Lower than the pin: ratchet the pin down (or flip to "enforced" at zero) in this PR.\n` +
            `Higher than the pin: a new backend-identity branch snuck into a corpus-E consumer — remove it.`,
        ).toEqual(entry.pin);
        // A fully clean file must not linger as pending.
        expect(
          literalMatches.length + comparisonMatches.length,
          `${entry.file} is clean — flip its map entry to "enforced"`,
        ).toBeGreaterThan(0);
      });
    }
  }

  it("map file list matches the filesystem (a moved/renamed consumer fails the suite)", () => {
    const missing = CONSUMER_LOCALITY_MAP.filter((entry) => {
      try {
        readCorpusFile(entry.file);
        return false;
      } catch {
        return true;
      }
    }).map((entry) => entry.file);
    expect(missing).toEqual([]);

    const duplicates = CONSUMER_LOCALITY_MAP.map((e) => e.file).filter(
      (file, i, all) => all.indexOf(file) !== i,
    );
    expect(duplicates).toEqual([]);
  });
});

/**
 * Reproduces the design's scoped measurement (Blocker 4 §4.1: grep for
 * `backend === "claude"|backend === "codex"|agentBackend === ` over
 * `src/lib/**` non-test outside `agent-backends/`; 55 lines at design time).
 * Equal-to-observed ratchet: when a slice removes branch lines, this pin must
 * be ratcheted down in the same change — it may never drift upward.
 */
export const SCOPED_BACKEND_IDENTITY_BRANCH_LINES = 5;

const SCOPED_GREP =
  /backend === "claude"|backend === "codex"|agentBackend === /;

function listLibSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => rel.split(path.sep).join("/"))
    .filter(
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.includes(".test.") &&
        !rel.startsWith("agent-backends/"),
    )
    .map((rel) => path.join(dir, rel));
}

describe("consumer-locality static half: scoped backend-identity count", () => {
  it(`src/lib outside agent-backends has exactly ${SCOPED_BACKEND_IDENTITY_BRANCH_LINES} backend-identity branch lines (design grep)`, () => {
    const libDir = LIB_ROOT;
    const perFile = new Map<string, number>();
    let total = 0;
    for (const file of listLibSources(libDir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      const count = lines.filter((line) => SCOPED_GREP.test(line)).length;
      if (count > 0) {
        perFile.set(path.relative(libDir, file), count);
        total += count;
      }
    }
    expect(
      total,
      `observed scoped backend-identity lines:\n${[...perFile.entries()]
        .map(([file, count]) => `  ${count}  ${file}`)
        .join("\n")}`,
    ).toBe(SCOPED_BACKEND_IDENTITY_BRANCH_LINES);
  });
});
