import {
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  pinnedSpecDocumentPath,
} from "./delivery-plan";
import type { SectionRole, SpecRevisionSnapshot } from "./schemas";

/**
 * The intent the seeded mission is rendered from, in the order a reader wants
 * it: what is wrong, then what changes. Roles absent from the pinned revision
 * are skipped rather than rendered empty.
 */
const SEEDED_MISSION_SECTIONS: readonly {
  role: SectionRole;
  label: string;
}[] = [
  { role: "intent_problem", label: "Problem" },
  { role: "intent_outcomes", label: "Outcomes" },
];

export interface SeededDeliveryPlanMissionInput {
  readonly pinnedRevision: SpecRevisionSnapshot;
}

/**
 * The mission `spec plan open` writes into a fresh managed definition, and the
 * exact text the charter rule compares a draft against. One renderer serves
 * both: a seed the gate could not reproduce would be a stub nothing detects.
 *
 * It is rendered from the pinned revision's intent so the planner starts from
 * the spec's own words rather than from a placeholder that says nothing about
 * the delivery — but it is still a seed, and propose refuses it unchanged.
 *
 * Every input is immutable. The spec's name and slug are deliberately absent:
 * `spec rename` rewrites both, and a seed reconstructed from the current name
 * would stop matching the text open wrote, letting the untouched stub propose.
 */
export function renderSeededDeliveryPlanMission(
  input: SeededDeliveryPlanMissionInput,
): string {
  const bodies = new Map<SectionRole, string>();
  for (const { version } of input.pinnedRevision.elements) {
    if (version.payload.kind !== "section") continue;
    if (bodies.has(version.payload.role)) continue;
    const body = version.payload.body.trim();
    if (body.length === 0) continue;
    bodies.set(version.payload.role, body);
  }
  return [
    `Deliver this specification as pinned at revision ${input.pinnedRevision.revision.number}.`,
    ...SEEDED_MISSION_SECTIONS.flatMap(({ role, label }) => {
      const body = bodies.get(role);
      return body === undefined ? [] : [`${label}: ${body}`];
    }),
  ].join("\n\n");
}

/**
 * The sources a fresh managed definition is seeded with: the server-owned
 * pinned-spec entry alone. The charter schema requires at least one source, so
 * seeding none is not available; seeding a server-owned entry keeps the seed
 * legible to the charter rule, which reads an authored source as the signal
 * that a planner has governed the plan. Finalization strips and re-injects it,
 * so it never accumulates.
 */
export function seededDeliveryPlanCharterSources(specSlug: string) {
  return [
    {
      rank: 1,
      id: NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
      label: "Pinned native SDD specification",
      type: "spec" as const,
      locator: pinnedSpecDocumentPath(specSlug),
      description:
        "The immutable specification revision this delivery candidate implements.",
    },
  ];
}
