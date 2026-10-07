import { isDeepStrictEqual } from "node:util";
import type { ArtifactStore } from "@/lib/artifacts/store";
import type { ContractCharter, ContractDocument } from "@/lib/execution-context/schemas";
import { RESERVED_CHARTER_DOCUMENT, RUN_DOCUMENTS_DIR } from "./documents";
import type { RunCharter, RunCharterRevision } from "./schemas";

/**
 * A workflow's charter as each context sees it. Launch and amendment render
 * the bundles (the run-wide fields and the invariants and sources meant for a
 * context) and freeze them as artifacts; a context freezes the latest bundle
 * for its key when it starts, as a summary in its contract and the full text
 * as a document beside its others.
 */

export type CharterBundle = Omit<ContractCharter, "documentPath" | "revision">;

export interface FrozenCharter {
  charter: RunCharter;
  bundles: NonNullable<RunCharterRevision["bundles"]>;
}

/** `key` null is any context no `appliesTo` names. */
const meantFor = (appliesTo: readonly string[] | undefined, key: string | null): boolean =>
  appliesTo === undefined || (key !== null && appliesTo.includes(key));

/** The run-wide fields, and the invariants and sources meant for `key`, sources highest authority first. */
export function charterBundleFor(charter: RunCharter, key: string | null): CharterBundle {
  return {
    mission: charter.mission,
    conventions: charter.conventions ?? [],
    nonGoals: charter.nonGoals ?? [],
    vocabulary: charter.vocabulary ?? [],
    testStrategy: charter.testStrategy ?? null,
    knownAmbiguities: charter.knownAmbiguities ?? [],
    invariants: (charter.invariants ?? [])
      .filter((invariant) => meantFor(invariant.appliesTo, key))
      .map(({ id, statement }) => ({ id, statement })),
    sourcesOfTruth: (charter.sourcesOfTruth ?? [])
      .filter((source) => meantFor(source.appliesTo, key))
      .sort((a, b) => a.rank - b.rank)
      .map(({ appliesTo: _appliesTo, ...source }) => source),
  };
}

function list(title: string, items: readonly string[]): string | null {
  return items.length === 0 ? null : [`## ${title}`, ...items.map((item) => `- ${item}`)].join("\n");
}

/** A context's charter in full, as the document its seats read. */
export function renderCharterDocument(bundle: CharterBundle): string {
  return [
    "# Charter",
    `## Mission\n${bundle.mission}`,
    bundle.invariants.length === 0
      ? null
      : [
          "## Invariants (every change must keep each one)",
          ...bundle.invariants.map((invariant) => `- \`${invariant.id}\`: ${invariant.statement}`),
        ].join("\n"),
    bundle.sourcesOfTruth.length === 0
      ? null
      : [
          "## Sources of truth (highest authority first; the higher one governs a conflict)",
          ...bundle.sourcesOfTruth.map(
            (source) =>
              `### ${source.rank}. ${source.label}\n- id: \`${source.id}\`\n- type: ${source.type}\n- where: \`${source.locator}\`\n- ${source.description}`,
          ),
        ].join("\n\n"),
    list("Non-goals", bundle.nonGoals),
    list("Conventions", bundle.conventions),
    list("Vocabulary", bundle.vocabulary),
    bundle.testStrategy === null ? null : `## Test strategy\n${bundle.testStrategy}`,
    list("Known ambiguities", bundle.knownAmbiguities),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n")
    .concat("\n");
}

/**
 * Renders and freezes the bundle for every context no `appliesTo` names and
 * one for each key one does, so the bundles follow from the charter alone.
 */
export async function freezeCharter(input: {
  charter: RunCharter;
  store: Pick<ArtifactStore, "snapshot">;
}): Promise<FrozenCharter> {
  const freeze = async (key: string | null): Promise<string> =>
    (await input.store.snapshot(Buffer.from(renderCharterDocument(charterBundleFor(input.charter, key))))).artifactId;
  const named = new Set(
    [...(input.charter.invariants ?? []), ...(input.charter.sourcesOfTruth ?? [])].flatMap((entry) => entry.appliesTo ?? []),
  );
  const byKey: Record<string, string> = {};
  for (const key of named) byKey[key] = await freeze(key);
  return { charter: input.charter, bundles: { default: await freeze(null), byKey } };
}

/** The revisions after a launch or amendment declared `next`: one more only when the charter changed. */
export function reviseCharter(
  revisions: readonly RunCharterRevision[],
  next: FrozenCharter | null,
  change: Pick<RunCharterRevision, "source" | "at" | "reason">,
): RunCharterRevision[] {
  const latest = revisions.at(-1);
  const current =
    latest === undefined || latest.charter === null || latest.bundles === null
      ? null
      : { charter: latest.charter, bundles: latest.bundles };
  if (isDeepStrictEqual(current, next)) return [...revisions];
  return [
    ...revisions,
    { revision: (latest?.revision ?? 0) + 1, ...change, charter: next?.charter ?? null, bundles: next?.bundles ?? null },
  ];
}

/** The charter in force, by revision, mission and the reason it was last amended; null when the run has none. */
export function currentCharter(
  revisions: readonly RunCharterRevision[],
): { revision: number; mission: string; reason: string | null } | null {
  const latest = revisions.at(-1);
  return latest === undefined || latest.charter === null
    ? null
    : { revision: latest.revision, mission: latest.charter.mission, reason: latest.reason };
}

/** What a context freezes when it starts: its charter summary and the full text as a document, or nothing. */
export function charterFor(input: {
  revisions: readonly RunCharterRevision[];
  key: string;
  contextId: string;
}): { charter: ContractCharter; document: ContractDocument } | null {
  const latest = input.revisions.at(-1);
  if (latest === undefined || latest.charter === null || latest.bundles === null) return null;
  const documentPath = `${RUN_DOCUMENTS_DIR}/${input.contextId}/${RESERVED_CHARTER_DOCUMENT}`;
  // An own entry only: a key such as `constructor` would otherwise find an object member.
  const scoped = Object.hasOwn(latest.bundles.byKey, input.key) ? latest.bundles.byKey[input.key] : undefined;
  return {
    charter: { ...charterBundleFor(latest.charter, input.key), revision: latest.revision, documentPath },
    document: {
      artifactId: scoped ?? latest.bundles.default,
      path: documentPath,
      description: "The run's charter as it governs this work: mission, invariants, sources of truth and non-goals.",
      readWhen: "Before you start, and whenever sources disagree or a finding may be outside the mission",
    },
  };
}
