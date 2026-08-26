import { describe, expect, it } from "vitest";

import {
  BESPOKE_OVERLAY_JUSTIFIED_ATTR,
  countBackendIdentityBranches,
  countBespokeDialogOverlays,
  countBroadcasterValueImports,
  countDeepBackendImports,
  countHandRolledProjectResolutionLadders,
  countHardcodedBackendEnumerations,
  countInternalViMocks,
  countNeutralModelParameterFields,
  countRoute404Rungs,
  countStateStoreConstructions,
  countStatusChipPills,
  countStructuredOutputProjections,
  evaluateSeamRatchet,
  extractImportSpecifiers,
  SEAMS,
  STATUS_CHIP_JUSTIFIED_ATTR,
  validateReviewedSeamCeilings,
  validateSeamCatalog,
  type SeamEvalInput,
} from "./seam-adoption";

describe("extractImportSpecifiers", () => {
  it("extracts static, dynamic, side-effect, and re-export specifiers", () => {
    const src = `
      import { a } from "@/lib/events/broadcaster";
      import type { B } from "./types";
      import "side-effect-module";
      export { c } from "../other";
      const mod = await import("@/lib/lazy");
    `;
    expect(extractImportSpecifiers(src).sort()).toEqual(
      [
        "@/lib/events/broadcaster",
        "./types",
        "side-effect-module",
        "../other",
        "@/lib/lazy",
      ].sort(),
    );
  });

  it("does not treat vi.mock specifiers as imports", () => {
    const src = `vi.mock("@/lib/sessions/mutations");`;
    expect(extractImportSpecifiers(src)).toEqual([]);
  });
});

describe("countBroadcasterValueImports", () => {
  it("counts value imports and value re-exports of the broadcaster module", () => {
    const src = `
      import { broadcast } from "@/lib/events/broadcaster";
      export { broadcast as b } from "../events/broadcaster";
    `;
    expect(countBroadcasterValueImports(src)).toBe(2);
  });

  it("ignores the typed publication layer and unrelated modules", () => {
    const src = `
      import { publishEvent } from "@/lib/events/publication";
      import { envelope } from "@/lib/events/sse-envelope";
    `;
    expect(countBroadcasterValueImports(src)).toBe(0);
  });

  it("counts dynamic imports and requires of the broadcaster", () => {
    const src = `
      const m = await import("@/lib/events/broadcaster");
      const r = require("@/lib/events/broadcaster");
    `;
    expect(countBroadcasterValueImports(src)).toBe(2);
  });

  it("does not count type-only imports (the sanctioned DI seam)", () => {
    const src = `
      import type { BroadcastFn } from "@/lib/events/broadcaster";
      import type { BroadcastFn as Fn } from "../events/broadcaster";
      export type { BroadcastFn } from "@/lib/events/broadcaster";
    `;
    expect(countBroadcasterValueImports(src)).toBe(0);
  });

  it("does not count named imports where every specifier is inline type-only", () => {
    const src = `import { type BroadcastFn } from "@/lib/events/broadcaster";`;
    expect(countBroadcasterValueImports(src)).toBe(0);
  });

  it("counts a mixed value+type import once (it still binds the value)", () => {
    const src = `
      import {
        broadcast as defaultBroadcast,
        type BroadcastFn,
      } from "@/lib/events/broadcaster";
    `;
    expect(countBroadcasterValueImports(src)).toBe(1);
  });
});

describe("countBackendIdentityBranches", () => {
  it("counts === and !== comparisons against backend literals", () => {
    const src = `
      if (backend === "claude") return x;
      const y = session.agentBackend !== "codex" ? 1 : 2;
    `;
    expect(countBackendIdentityBranches(src)).toBe(2);
  });

  it("counts reversed-operand comparisons", () => {
    const src = `if ("codex" === conversation.backend) doThing();`;
    expect(countBackendIdentityBranches(src)).toBe(1);
  });

  it("counts switch case labels on backend literals", () => {
    const src = `
      switch (backend) {
        case "claude":
          return a;
        case "codex":
          return b;
      }
    `;
    expect(countBackendIdentityBranches(src)).toBe(2);
  });

  it("does not count object construction or non-backend literals", () => {
    const src = `
      const ref = { backend: "claude", sessionId: id };
      if (kind === "claude-skills") return x;
      if (mode === "codex-plugins") return y;
    `;
    expect(countBackendIdentityBranches(src)).toBe(0);
  });
});

describe("countNeutralModelParameterFields", () => {
  it("counts retired provider-shaped fields while ignoring explicit migration rejection gates", () => {
    const src = `
      interface TurnInput { reasoningEffort?: string }
      const request = { fastMode: true };
      consume(runtime.codexFastMode);

      reasoningEffort: z.never({ error: "migrated" }).optional(),
      fastMode: migratedBackendSelectionField(),
      reasoningEffort: body["reasoningEffort"],
    `;

    expect(countNeutralModelParameterFields(src)).toBe(3);
  });

  it("ignores comments that name the retired fields", () => {
    expect(
      countNeutralModelParameterFields(`
        // reasoningEffort is retired.
        /* codexFastMode and fastMode are adapter details. */
      `),
    ).toBe(0);
  });
});

describe("countDeepBackendImports", () => {
  it("counts imports from adapter subdirectories", () => {
    const src = `
      import { mapBlocks } from "@/lib/agent-backends/claude/map-content-blocks";
      import type { CodexThing } from "@/lib/agent-backends/codex/schemas";
    `;
    expect(countDeepBackendImports(src)).toBe(2);
  });

  it("counts provider SDK imports including subpaths", () => {
    const src = `
      import { query } from "@anthropic-ai/claude-agent-sdk";
      import { Codex } from "@openai/codex-sdk";
      import { x } from "@openai/codex-sdk/internal";
    `;
    expect(countDeepBackendImports(src)).toBe(3);
  });

  it("ignores imports of the seam's neutral surface", () => {
    const src = `
      import { registry } from "@/lib/agent-backends/registry";
      import type { AgentBackendId } from "@/lib/shared/schemas";
    `;
    expect(countDeepBackendImports(src)).toBe(0);
  });
});

describe("countRoute404Rungs", () => {
  it("counts { status: 404 } response literals", () => {
    const src = `return NextResponse.json({ error: "Not found" }, { status: 404 });`;
    expect(countRoute404Rungs(src)).toBe(1);
  });

  it("counts 404 passed as a trailing call argument (jsonError style)", () => {
    const src = `
      if (!projectPath) return jsonError("Project not found", 404);
      if (!session)
        return jsonError(
          "Session not found",
          404,
        );
    `;
    expect(countRoute404Rungs(src)).toBe(2);
  });

  it("does not count other status codes", () => {
    const src = `
      return NextResponse.json({ error: "bad" }, { status: 400 });
      return jsonError("conflict", 409);
    `;
    expect(countRoute404Rungs(src)).toBe(0);
  });

  it("counts a hand-rolled resolveProjectPath + null->notFound ladder (no 404 literal)", () => {
    const src = `
      const projectPath = await resolveProjectPath(projectName);
      if (!projectPath) {
        logger.warn("miss", { projectName });
        return notFound("Project not found");
      }
    `;
    expect(countRoute404Rungs(src)).toBe(1);
  });
});

describe("countHandRolledProjectResolutionLadders", () => {
  it("counts an awaited resolveProjectPath + null-guard returning notFound", () => {
    const src = `
      const projectPath = await resolveProjectPath(projectName);
      if (!projectPath) return notFound("Project not found");
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(1);
  });

  it("counts the deps.resolveProjectPath variant and a === null guard", () => {
    const src = `
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return notFound("Project not found");
      }
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(1);
  });

  it("does not count guards that throw instead of returning notFound", () => {
    const src = `
      const projectPath = await deps.resolveProjectPath(projectName);
      if (!projectPath) {
        throw new CapabilityRouteNotFoundError("Project not found");
      }
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(0);
  });

  it("does not count lookup helpers that return null on a miss", () => {
    const src = `
      const projectPath = await deps.resolveProjectPath(projectNameHint);
      if (!projectPath) return null;
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(0);
  });

  it("does not count resolveProjectOr404 passing the resolver as a dependency", () => {
    const src = `
      const project = await resolveProjectOr404({ resolveProjectPath }, name);
      if (!project.ok) return project.response;
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(0);
  });

  it("does not double-count a ladder whose null branch already emits a 404 literal", () => {
    // The literal 404 is counted by the status/trailing-arg rungs; the ladder
    // detector only fires on the notFound(...) helper shape.
    const src = `
      const projectPath = await resolveProjectPath(projectName);
      if (!projectPath)
        return NextResponse.json({ error: "x" }, { status: 404 });
    `;
    expect(countHandRolledProjectResolutionLadders(src)).toBe(0);
  });
});

describe("countBespokeDialogOverlays", () => {
  it("counts hand-authored role=dialog / role=alertdialog JSX attributes", () => {
    const src = `
      <div role="dialog" aria-label="x">a</div>
      <aside role='alertdialog'>b</aside>
      <div role={"dialog"}>c</div>
    `;
    expect(countBespokeDialogOverlays(src)).toBe(3);
  });

  it("does not count the attribute when it only appears in prose comments", () => {
    const src = `
      // Radix owns the role="dialog" wiring for this primitive.
      /* composes ui/Dialog whose role="dialog" is internal */
      export function Wrapper() {
        return <div>no overlay here</div>;
      }
    `;
    expect(countBespokeDialogOverlays(src)).toBe(0);
  });

  it("does not count a role object property (config maps, not rendered overlays)", () => {
    const src = `const descriptor = { role: "dialog", label: "x" };`;
    expect(countBespokeDialogOverlays(src)).toBe(0);
  });

  it("subtracts sanctioned sites carrying the data-bespoke-overlay-justified marker", () => {
    const src = `
      <div role="dialog" ${BESPOKE_OVERLAY_JUSTIFIED_ATTR} aria-label="peek" />
    `;
    expect(countBespokeDialogOverlays(src)).toBe(0);
  });

  it("still counts an UNmarked overlay authored beside a marked survivor (per-site, not per-file)", () => {
    const src = `
      <div role="dialog" ${BESPOKE_OVERLAY_JUSTIFIED_ATTR} aria-label="survivor" />
      <div role="dialog" aria-label="new hand-rolled overlay" />
    `;
    expect(countBespokeDialogOverlays(src)).toBe(1);
  });
});

describe("countStatusChipPills", () => {
  const countAtPath = countStatusChipPills as (
    source: string,
    relPath: string,
  ) => number;

  it("counts a class literal co-locating all four StatusChip base tokens", () => {
    const src = `
      const chip =
        "inline-flex items-center rounded-full border border-solid px-[8px] py-[2px] font-mono text-[0.7rem] font-medium";
    `;
    expect(countStatusChipPills(src)).toBe(1);
  });

  it("counts template-literal class strings too", () => {
    const src =
      "const c = `rounded-full border border-solid font-mono text-[0.7rem]`;";
    expect(countStatusChipPills(src)).toBe(1);
  });

  it("does not count pills missing any one of the four base tokens", () => {
    const src = `
      const badge = "rounded-[20px] font-mono text-[0.7rem] uppercase";
      const sharp = "rounded-sm border border-solid font-mono text-[0.7rem]";
      const noBorder = "rounded-full font-mono text-[0.7rem]";
      const wrongSize = "rounded-full border border-solid font-mono text-[0.72rem]";
    `;
    expect(countStatusChipPills(src)).toBe(0);
  });

  it("does not count the tokens when they only appear in a comment", () => {
    const src = `
      // The ui/StatusChip base is rounded-full border border-solid font-mono text-[0.7rem].
      export function X() { return null; }
    `;
    expect(countStatusChipPills(src)).toBe(0);
  });

  it("subtracts a distinct source marker carrying the reviewed site marker", () => {
    const src = `
      <span
        ${STATUS_CHIP_JUSTIFIED_ATTR}="source-line-marker"
        className="rounded-full border border-solid font-mono text-[0.7rem]"
      />
    `;
    expect(
      countAtPath(src, "src/components/markdown/Markdown.stories.tsx"),
    ).toBe(0);
  });

  it("does not honor the source-marker exemption outside its reviewed file", () => {
    const src = `
      <span
        ${STATUS_CHIP_JUSTIFIED_ATTR}="source-line-marker"
        className="rounded-full border border-solid font-mono text-[0.7rem]"
      />
    `;
    expect(countAtPath(src, "src/features/session/UnreviewedPill.tsx")).toBe(1);
  });

  it("does not honor an unreviewed marker value inside the reviewed file", () => {
    const src = `
      <span
        ${STATUS_CHIP_JUSTIFIED_ATTR}="anything"
        className="rounded-full border border-solid font-mono text-[0.7rem]"
      />
    `;
    expect(
      countAtPath(src, "src/components/markdown/Markdown.stories.tsx"),
    ).toBe(1);
  });

  it("still counts an unmarked pill beside a reviewed source marker", () => {
    const src = `
      <span
        ${STATUS_CHIP_JUSTIFIED_ATTR}="source-line-marker"
        className="rounded-full border border-solid font-mono text-[0.7rem]"
      />
      <span className="rounded-full border border-solid font-mono text-[0.7rem]" />
    `;
    expect(
      countAtPath(src, "src/components/markdown/Markdown.stories.tsx"),
    ).toBe(1);
  });

  it("does not let a marker on a non-matching element hide an unmarked pill", () => {
    const src = `
      <span ${STATUS_CHIP_JUSTIFIED_ATTR}="source-line-marker" className="rounded-sm" />
      <span className="rounded-full border border-solid font-mono text-[0.7rem]" />
    `;
    expect(
      countAtPath(src, "src/components/markdown/Markdown.stories.tsx"),
    ).toBe(1);
  });
});

describe("countInternalViMocks", () => {
  const file = "src/features/session/Panel.test.tsx";

  it("counts internal alias mocks", () => {
    const src = `
      vi.mock("@/lib/sessions/mutations");
      vi.mock("@/stores/unified-panel.store", () => ({}));
    `;
    expect(countInternalViMocks(src, file)).toBe(2);
  });

  it("counts relative internal mocks", () => {
    const src = `vi.mock("../registry-core");`;
    expect(countInternalViMocks(src, "src/cli/commands/thing.test.ts")).toBe(1);
  });

  it("excludes the infrastructure allowlist", () => {
    const src = `
      vi.mock("@/lib/logging");
      vi.mock("@/lib/logging/logger");
      vi.mock("@/lib/shared/sdk-env");
      vi.mock("@/lib/sdk-env");
    `;
    expect(countInternalViMocks(src, file)).toBe(0);
  });

  it("excludes infrastructure reached via relative specifiers", () => {
    const src = `vi.mock("../logging");`;
    expect(countInternalViMocks(src, "src/lib/prompt/driver.test.ts")).toBe(0);
  });

  it("excludes external package mocks", () => {
    const src = `
      vi.mock("next/navigation");
      vi.mock("react-virtuoso");
      vi.mock("@anthropic-ai/claude-agent-sdk");
    `;
    expect(countInternalViMocks(src, file)).toBe(0);
  });
});

describe("countStateStoreConstructions", () => {
  it("counts call expressions of the imported factory", () => {
    const src = `
      import { createStateStore } from "@/lib/state-store";
      const store = createStateStore({ db, writeQueue, repos });
    `;
    expect(countStateStoreConstructions(src)).toBe(1);
  });

  it("follows import aliases to renamed call sites", () => {
    const src = `
      import { createStateStore as makeStore } from "@/lib/state-store";
      const a = makeStore(deps);
      const b = makeStore(otherDeps);
    `;
    expect(countStateStoreConstructions(src)).toBe(2);
  });

  it("counts namespace-member construction calls", () => {
    const src = `
      import * as stateStore from "@/lib/state-store";
      const store = stateStore.createStateStore(deps);
    `;
    expect(countStateStoreConstructions(src)).toBe(1);
  });

  it("counts constructions through require bindings", () => {
    const src = `
      const { createStateStore: build } = require("@/lib/state-store");
      const store = build(deps);
    `;
    expect(countStateStoreConstructions(src)).toBe(1);
  });

  it("counts zero for imports used only in type positions (ReturnType debt)", () => {
    const src = `
      import { createStateStore as createStateManager } from "@/lib/state-store";
      type StateManager = ReturnType<typeof createStateManager>;
      type Picked = Pick<ReturnType<typeof createStateManager>, "mutateState">;
    `;
    expect(countStateStoreConstructions(src)).toBe(0);
  });

  it("counts zero for type-only imports of the factory", () => {
    const src = `
      import type { createStateStore } from "@/lib/state-store";
      type Store = ReturnType<typeof createStateStore>;
    `;
    expect(countStateStoreConstructions(src)).toBe(0);
  });

  it("does not count calls of a same-named binding from another module", () => {
    const src = `
      import { createStateStore } from "@/lib/other-store";
      const store = createStateStore(deps);
    `;
    expect(countStateStoreConstructions(src)).toBe(0);
  });

  it("does not count the sanctioned singleton accessor", () => {
    const src = `
      import { getStateStore } from "@/lib/state-store";
      const store = getStateStore();
    `;
    expect(countStateStoreConstructions(src)).toBe(0);
  });
});

describe("countStructuredOutputProjections", () => {
  it("counts hand-written *_JSON_SCHEMA object literals", () => {
    const src = `
      const SHORT_STRING_JSON_SCHEMA = {
        type: "string",
      };
      export const COMMIT_MESSAGE_JSON_SCHEMA: Record<string, unknown> = {
        type: "object",
      };
    `;
    expect(countStructuredOutputProjections(src)).toBe(2);
  });

  it("counts hand-written *_OUTPUT_SCHEMA object literals", () => {
    const src = `
      export const VALIDATOR_OUTPUT_SCHEMA = {
        type: "object",
      } as const;
      const CONFLICT_ENTRIES_OUTPUT_SCHEMA = {
        type: "object",
      };
    `;
    expect(countStructuredOutputProjections(src)).toBe(2);
  });

  it("counts inline object literals flowing into outputSchema", () => {
    const src = `
      await callAgent({
        outputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      });
    `;
    expect(countStructuredOutputProjections(src)).toBe(1);
  });

  it("counts inline object literals flowing into outputFormat.schema", () => {
    const src = `
      const result = await executeWorkflowTaskRun({
        kind: "task_run",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { entries: { type: "array" } },
          },
        },
      });
    `;
    expect(countStructuredOutputProjections(src)).toBe(1);
  });

  it("does not count z.toJSONSchema-derived constants or flows", () => {
    const src = `
      export const COMPACTION_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(schema);
      await callAgent({ outputSchema: z.toJSONSchema(replySchema) });
      await run({ outputFormat: { type: "json_schema", schema: z.toJSONSchema(s) } });
    `;
    expect(countStructuredOutputProjections(src)).toBe(0);
  });

  it("does not count schema-shaped type annotations outside outputFormat", () => {
    const src = `
      async function parseJsonBody<T>(
        request: Request,
        schema: {
          safeParse(value: unknown): { success: boolean };
        },
      ): Promise<T> {}
    `;
    expect(countStructuredOutputProjections(src)).toBe(0);
  });

  it("does not count named-constant flows (their declarations carry the count)", () => {
    const src = `
      await run({
        outputFormat: {
          type: "json_schema",
          schema: CONFLICT_ENTRIES_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        },
      });
    `;
    expect(countStructuredOutputProjections(src)).toBe(0);
  });
});

describe("countHardcodedBackendEnumerations", () => {
  it("counts backend-id pair array literals in either order", () => {
    const src = `
      const ids = ["claude", "codex"];
      const reversed = ['codex', 'claude'];
    `;
    expect(countHardcodedBackendEnumerations(src)).toBe(2);
  });

  it("counts backend-id map keys (label/tone maps), quoted or bare", () => {
    const src = `
      const agentColorClass = {
        claude: "bg-cyan-glow text-cyan",
        codex: "bg-violet-glow text-violet",
      };
      const labels = { "claude": "Claude", "codex": "Codex" };
    `;
    expect(countHardcodedBackendEnumerations(src)).toBe(4);
  });

  it("counts Record<AgentBackendId, …> closed map types", () => {
    const src = `const m: Record<AgentBackendId, string> = base;`;
    expect(countHardcodedBackendEnumerations(src)).toBe(1);
  });

  it("does not count object construction, ternaries, case labels, or identity comparisons", () => {
    const src = `
      const cfg = { backend: "claude", model: "opus" };
      const other = agent === "claude" ? "codex" : "claude";
      switch (backend) { case "claude": break; case "codex": break; }
      if (backend === "codex") return;
    `;
    expect(countHardcodedBackendEnumerations(src)).toBe(0);
  });
});

describe("evaluateSeamRatchet", () => {
  const input = (
    id: string,
    observed: number,
    ceiling: number | null,
  ): SeamEvalInput => ({ id, observed, ceiling });

  it("passes when every observed count equals its ceiling", () => {
    const result = evaluateSeamRatchet([input("a", 5, 5), input("b", 0, 0)]);
    expect(result.ok).toBe(true);
    expect(result.statuses.every((s) => s.state === "ok")).toBe(true);
  });

  it("fails when observed exceeds the ceiling (regression)", () => {
    const result = evaluateSeamRatchet([input("a", 6, 5)]);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("above-ceiling");
  });

  it("fails when observed is below the ceiling (equal-to-observed rule)", () => {
    const result = evaluateSeamRatchet([input("a", 3, 5)]);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("below-ceiling");
  });

  it("fails when a seam has no committed ceiling", () => {
    const result = evaluateSeamRatchet([input("a", 3, null)]);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("unseeded");
  });

  it("fails on stale baseline entries with no matching seam", () => {
    const result = evaluateSeamRatchet(
      [input("a", 5, 5)],
      ["a", "deleted-seam"],
    );
    expect(result.ok).toBe(false);
    expect(result.statuses.some((s) => s.state === "stale-baseline")).toBe(
      true,
    );
  });
});

describe("seam catalog", () => {
  it("rejects a generated baseline that differs from the reviewed catalog ceilings", () => {
    expect(
      validateReviewedSeamCeilings(
        [
          { id: "backend-identity-branches", reviewedCeiling: 26 },
          { id: "route-404-ladders", reviewedCeiling: 2 },
        ],
        {
          "backend-identity-branches": 28,
          "route-404-ladders": 2,
        },
      ),
    ).toEqual([
      "backend-identity-branches: generated ceiling 28 does not match reviewed ceiling 26.",
    ]);
  });

  it("accepts generated ceilings that match the reviewed catalog", () => {
    expect(
      validateReviewedSeamCeilings(
        [
          { id: "backend-identity-branches", reviewedCeiling: 26 },
          { id: "route-404-ladders", reviewedCeiling: 2 },
        ],
        {
          "backend-identity-branches": 26,
          "route-404-ladders": 2,
        },
      ),
    ).toEqual([]);
  });

  it("tracks the live seams from the consolidated plan (the data-tooltip seam is retired — enforced by the no-data-tooltip-attribute ESLint rule)", () => {
    expect(SEAMS.map((s) => s.id).sort()).toEqual(
      [
        "broadcaster-direct-imports",
        "backend-identity-branches",
        "backend-deep-imports",
        "route-404-ladders",
        "bespoke-dialog-overlays",
        "status-chip-pills",
        "internal-vi-mocks",
        "neutral-model-parameter-fields",
        "state-store-construction",
        "structured-output-schema-literals",
        "hardcoded-backend-enumeration",
      ].sort(),
    );
  });

  it("is internally consistent", () => {
    expect(validateSeamCatalog(SEAMS)).toEqual([]);
  });

  it("keeps allowlisted files out of every FILE-excluding seam's corpus", () => {
    for (const seam of SEAMS) {
      for (const entry of seam.allowlist) {
        const probe = entry.path.endsWith("/")
          ? `${entry.path}anything.ts`
          : entry.path;
        if (entry.siteLevel) {
          expect(
            seam.inCorpus(probe),
            `${seam.id} should retain site-allowlisted ${entry.path} in its corpus`,
          ).toBe(true);
          continue;
        }
        expect(
          seam.inCorpus(probe),
          `${seam.id} should exclude allowlisted ${entry.path}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the bespoke-overlay survivor files IN the corpus (site-level, not file-level, exclusion — the Phase 5 false-zero fix)", () => {
    const seam = SEAMS.find((s) => s.id === "bespoke-dialog-overlays")!;
    // Every sanctioned survivor file stays in the corpus, so a NEW unmarked
    // role="dialog" added to it is still counted.
    for (const entry of seam.allowlist) {
      expect(
        seam.inCorpus(entry.path),
        `${entry.path} must stay in-corpus (site-level allowlisting)`,
      ).toBe(true);
    }
    // A marked survivor site is subtracted; an unmarked overlay in the SAME
    // source still counts — proving the exception is per-site, not per-file.
    const survivorPlusNew = `
      <div role="dialog" ${BESPOKE_OVERLAY_JUSTIFIED_ATTR} aria-label="peek" />
      <div role="dialog" aria-label="newly hand-rolled overlay" />
    `;
    expect(seam.count(survivorPlusNew, "src/features/x/Foo.tsx")).toBe(1);
  });
});

describe("seam corpus predicates", () => {
  const byId = new Map(SEAMS.map((s) => [s.id, s]));

  it("broadcaster seam excludes the events domain and tests", () => {
    const seam = byId.get("broadcaster-direct-imports")!;
    expect(seam.inCorpus("src/lib/jobs/queue.ts")).toBe(true);
    expect(seam.inCorpus("src/lib/events/publication.ts")).toBe(false);
    expect(seam.inCorpus("src/lib/jobs/queue.test.ts")).toBe(false);
  });

  it("backend-identity seam excludes the adapter seam, tests, and stories", () => {
    const seam = byId.get("backend-identity-branches")!;
    expect(seam.inCorpus("src/lib/workflows/collaboration/helpers.ts")).toBe(
      true,
    );
    expect(seam.inCorpus("src/lib/agent-backends/claude/runtime.ts")).toBe(
      false,
    );
    expect(
      seam.inCorpus("src/lib/workflows/collaboration/envelope.test.ts"),
    ).toBe(false);
    expect(
      seam.inCorpus("src/features/session/mobile/Toolbar.stories.tsx"),
    ).toBe(false);
  });

  it("neutral model-parameter seam excludes provider owners, migrations, archives, and fixtures", () => {
    const seam = byId.get("neutral-model-parameter-fields")!;
    expect(seam.inCorpus("src/lib/prompt/dispatch.ts")).toBe(true);
    expect(seam.inCorpus("src/lib/agent-backends/codex/translator.ts")).toBe(
      false,
    );
    expect(
      seam.inCorpus(
        "src/lib/state-store/migrations/0035-generalized-model-selection.ts",
      ),
    ).toBe(false);
    expect(
      seam.inCorpus("src/lib/workflow-graph/archived-legacy-decode.ts"),
    ).toBe(false);
    expect(
      seam.inCorpus(
        "src/features/session/conversation/collab/envelope-adapter.ts",
      ),
    ).toBe(false);
    expect(seam.inCorpus("src/lib/prompt/testing/request-fixture.ts")).toBe(
      false,
    );
    expect(seam.inCorpus("src/lib/prompt/request.test.ts")).toBe(false);
  });

  it("deep-import seam includes tests but excludes the adapter seam", () => {
    const seam = byId.get("backend-deep-imports")!;
    expect(
      seam.inCorpus("src/lib/workflows/conversation/actor-impls.test.ts"),
    ).toBe(true);
    expect(seam.inCorpus("src/lib/agent-backends/codex/translator.ts")).toBe(
      false,
    );
  });

  it("404-ladder seam covers route-handler modules", () => {
    const seam = byId.get("route-404-ladders")!;
    expect(seam.inCorpus("src/lib/mcp/config-route-handlers.ts")).toBe(true);
    expect(seam.inCorpus("src/lib/shared/route-resolution.ts")).toBe(false);
    expect(seam.inCorpus("src/lib/mcp/service.ts")).toBe(false);
  });

  it("404-ladder seam covers response-producing *-handler modules", () => {
    const seam = byId.get("route-404-ladders")!;
    expect(seam.inCorpus("src/lib/workflows/definition-edit-handler.ts")).toBe(
      true,
    );
    expect(
      seam.inCorpus("src/lib/workflows/workflow-draft/route-handler.ts"),
    ).toBe(true);
  });

  it("404-ladder seam excludes the justified non-route *-handler helpers", () => {
    const seam = byId.get("route-404-ladders")!;
    expect(
      seam.inCorpus("src/features/session/panes/pane-fork-handler.ts"),
    ).toBe(false);
    expect(
      seam.inCorpus("src/lib/workflows/conversation/external-turn-handler.ts"),
    ).toBe(false);
  });

  it("vi.mock seam covers only test files", () => {
    const seam = byId.get("internal-vi-mocks")!;
    expect(seam.inCorpus("src/features/session/Panel.test.tsx")).toBe(true);
    expect(seam.inCorpus("src/features/session/Panel.tsx")).toBe(false);
  });

  it("status-chip seam covers source + stories minus tests, excluding the primitive", () => {
    const seam = byId.get("status-chip-pills")!;
    expect(seam.inCorpus("src/components/mcp/McpInfoChip.tsx")).toBe(true);
    expect(seam.inCorpus("src/components/ui/StatusChip.stories.tsx")).toBe(
      true,
    );
    // The primitive that owns the base geometry is the seam, not the population.
    expect(seam.inCorpus("src/components/ui/StatusChip.tsx")).toBe(false);
    expect(seam.inCorpus("src/components/ui/StatusChip.test.tsx")).toBe(false);
  });

  it("backend-enumeration seam covers UI code only, minus tests/stories and the justified allowlist", () => {
    const seam = byId.get("hardcoded-backend-enumeration")!;
    expect(seam.inCorpus("src/components/AgentPill.tsx")).toBe(true);
    expect(
      seam.inCorpus("src/features/config/sections/DefaultsSection.tsx"),
    ).toBe(true);
    expect(seam.inCorpus("src/hooks/use-something.ts")).toBe(true);
    // Non-UI domain code is covered by the backend-identity seam instead.
    expect(seam.inCorpus("src/lib/prompt/queue.ts")).toBe(false);
    expect(seam.inCorpus("src/components/AgentPill.test.tsx")).toBe(false);
    expect(seam.inCorpus("src/components/ui/Badge.stories.tsx")).toBe(false);
    // D19: collaboration's explicit two-agent pair UI is exempt.
    expect(
      seam.inCorpus(
        "src/features/session/conversation/collab/CollabPassage.tsx",
      ),
    ).toBe(false);
  });

  it("state-store seam excludes the owning domain and the test fixture", () => {
    const seam = byId.get("state-store-construction")!;
    expect(seam.inCorpus("src/lib/mcp/runtime-apply.ts")).toBe(true);
    expect(seam.inCorpus("src/lib/state-store/store.ts")).toBe(false);
    expect(seam.inCorpus("src/lib/shared/testing/persistence-fixture.ts")).toBe(
      false,
    );
    expect(seam.inCorpus("src/lib/mcp/runtime-apply.test.ts")).toBe(false);
  });

  it("structured-output seam excludes tests, stories, and fixture modules", () => {
    const seam = byId.get("structured-output-schema-literals")!;
    expect(seam.inCorpus("src/lib/workflows/collaboration/types.ts")).toBe(
      true,
    );
    expect(seam.inCorpus("src/lib/agent-runs/schemas.test.ts")).toBe(false);
    // A story passes an `outputSchema` as inert prop data to render a node; it
    // authors no contract any agent run consumes, so it is prototype fixture
    // code rather than migration population.
    expect(
      seam.inCorpus(
        "src/components/workflow-graph/ExecutionContextNode.stories.tsx",
      ),
    ).toBe(false);
    expect(seam.inCorpus("src/lib/shared/testing/persistence-fixture.ts")).toBe(
      false,
    );
  });
});
