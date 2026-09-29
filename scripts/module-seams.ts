import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  readValueGraph,
  shortestImportPath,
  type ValueGraph,
} from "./module-imports";
import { crossDomainCycleEdges, type CycleEdge } from "./module-graph-analysis";
import { productionEntryFiles } from "./module-graph-roots";

export const CORE_BOUNDARIES = [
  {
    roots: [
      "src/lib/tickets/schemas.ts",
      "src/lib/commands/schemas.ts",
      "src/lib/agent-backends/errors.ts",
      "src/lib/agent-backends/execution-schemas.ts",
      "src/lib/workflows/primitives/agent-call-vocabulary.ts",
    ],
    forbidden: ["src/lib/agent-backends/execution-admission.ts"],
  },
  {
    roots: ["src/lib/sessions/optimistic.ts"],
    forbidden: [
      "src/lib/sessions/optimistic-production.ts",
      "src/lib/prompt/sdk-driver.ts",
      "src/lib/jobs/queue.ts",
      "src/lib/notifications/service.ts",
      "src/lib/workflows/production.ts",
    ],
  },
  {
    roots: [
      "src/lib/workflows/conversation/manager.ts",
      "src/lib/workflows/conversation/testing/lifecycle-fixture.ts",
    ],
    forbidden: [
      "src/lib/workflows/conversation/lifecycle.ts",
      "src/lib/workflows/conversation/production.ts",
      "src/lib/workflows/production.ts",
    ],
  },
  {
    roots: [
      "src/lib/workflow-graph/workflow-manager.ts",
      "src/lib/workflow-graph/testing/cohort-engine-harness.ts",
    ],
    forbidden: [
      "src/lib/workflow-graph/production.ts",
      "src/lib/workflows/production.ts",
      "src/lib/workflows/conversation/lifecycle.ts",
      "src/lib/workflows/conversation/production.ts",
    ],
  },
  {
    roots: ["src/lib/specs/delivery-plan-policy.ts"],
    forbidden: ["src/lib/state-store/"],
  },
  {
    roots: ["src/lib/workflow-graph/boundary-event-projection.ts"],
    forbidden: [
      "src/lib/workflow-graph/execution-events.ts",
      "src/lib/events/",
      "src/lib/notifications/",
      "src/lib/push-notification/",
    ],
  },
];

export const cycleAllowanceSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
  removeWhen: z.string().min(1),
});
const baselineSchema = z.object({
  version: z.literal(1),
  allowances: z.array(cycleAllowanceSchema),
});
export type CycleAllowance = z.infer<typeof cycleAllowanceSchema>;

export function compareCycleBaseline(
  edges: readonly Pick<CycleEdge, "from" | "to">[],
  baseline: readonly CycleAllowance[],
) {
  const key = ({ from, to }: { from: string; to: string }) =>
    `${from} -> ${to}`;
  const current = new Set(edges.map(key));
  const reviewed = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of baseline) {
    const id = key(entry);
    if (reviewed.has(id)) duplicates.add(id);
    reviewed.add(id);
  }
  return {
    added: [...current].filter((edge) => !reviewed.has(edge)).sort(),
    removed: [...reviewed].filter((edge) => !current.has(edge)).sort(),
    duplicates: [...duplicates].sort(),
  };
}

export function coreBoundaryViolations(graph: ValueGraph): string[][] {
  return CORE_BOUNDARIES.flatMap(({ roots, forbidden }) =>
    roots.flatMap((root) =>
      [...graph.keys()]
        .filter((file) =>
          forbidden.some((target) =>
            target.endsWith("/") ? file.startsWith(target) : file === target,
          ),
        )
        .flatMap((target) => {
          const chain = shortestImportPath(graph, root, target);
          return chain === null ? [] : [chain];
        }),
    ),
  );
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const filename = path.join(root, "scripts/module-cycle-baseline.json");
  const baseline = baselineSchema.parse(
    JSON.parse(readFileSync(filename, "utf8")),
  );
  const productionRoots = productionEntryFiles(root);
  const graph = readValueGraph(root, [
    ...productionRoots,
    ...CORE_BOUNDARIES.flatMap((rule) => rule.roots),
  ]);
  const coreFailures = coreBoundaryViolations(graph);
  // Fixtures join core checks, but only production-reachable cycles are baselined.
  const productionFiles = new Set<string>();
  const pending = [...productionRoots];
  while (pending.length) {
    const file = pending.pop();
    if (file === undefined || productionFiles.has(file)) continue;
    productionFiles.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  const production = new Map(
    [...graph].filter(([file]) => productionFiles.has(file)),
  );
  const cycles = crossDomainCycleEdges(production);
  const changes = compareCycleBaseline(cycles, baseline.allowances);
  if (
    process.argv.includes("--ratchet") &&
    coreFailures.length === 0 &&
    changes.added.length === 0 &&
    changes.duplicates.length === 0
  ) {
    const active = new Set(cycles.map(({ from, to }) => `${from} -> ${to}`));
    baseline.allowances = baseline.allowances.filter(({ from, to }) =>
      active.has(`${from} -> ${to}`),
    );
    writeFileSync(filename, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `module-seams: ratcheted to ${baseline.allowances.length} reviewed cycle edges`,
    );
    return;
  }
  if (
    coreFailures.length ||
    changes.added.length ||
    changes.removed.length ||
    changes.duplicates.length
  ) {
    for (const chain of coreFailures)
      console.error(`Forbidden production dependency: ${chain.join(" -> ")}`);
    for (const edge of changes.added)
      console.error(`New cross-domain cycle edge: ${edge}`);
    for (const edge of changes.duplicates)
      console.error(`Duplicate cycle allowance: ${edge}`);
    if (changes.removed.length)
      console.error(
        `${changes.removed.length} cycle edges removed; run bun scripts/module-seams.ts --ratchet to shrink the baseline.`,
      );
    process.exitCode = 1;
    return;
  }
  console.log(
    `module-seams: ${CORE_BOUNDARIES.length} core boundaries and ${cycles.length} reviewed cycle edges OK`,
  );
}

if (import.meta.main) await main();
