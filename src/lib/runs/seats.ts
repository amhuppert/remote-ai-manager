/**
 * Seat resolution for a launch: each seat's backend and admitted model, and
 * the profile each seat runs under, checked before anything is recorded.
 */
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentLaunchRequest, ResolvedSeat } from "./launch";
import { DEFAULT_REVIEWER_PROFILE, RUN_SETTING_DEFAULTS } from "./settings";

export type SeatResolution =
  | { ok: true; seat: ResolvedSeat }
  | { ok: false; status: number; error: string; code?: string };

export type SeatsResolution =
  | {
      ok: true;
      seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
    }
  | { ok: false; status: number; error: string; code?: string };

export interface SeatResolverDeps {
  /** One seat's backend admission and configured model. */
  admitSeat(
    projectPath: string,
    backend: AgentBackendId | undefined,
    modelSelection: BackendModelSelection | undefined,
  ): Promise<SeatResolution>;
  /** Whether a profile resolves for this project, as a seat's spawn resolves it. */
  checkProfile(
    projectPath: string,
    ref: AgentProfileRef,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

/**
 * Every seat a launch names: its profile, which is resolved here as the seat's
 * spawn will resolve it, then its backend and model. A launch naming a profile
 * that does not exist is refused before anything is recorded. Seats
 * spawned later (reviewers, loop passes, replacements, contexts an amendment
 * adds) still resolve at spawn, so a profile deleted after launch fails there.
 */
export function createSeatResolver(
  deps: SeatResolverDeps,
): (input: {
  projectPath: string;
  request: AgentLaunchRequest;
}) => Promise<SeatsResolution> {
  async function seat(
    projectPath: string,
    /** The seat as a refusal names it. */
    named: string,
    requested: {
      backend?: AgentBackendId;
      modelSelection?: BackendModelSelection;
    },
    profile: AgentProfileRef,
  ): Promise<SeatResolution> {
    const resolves = await deps.checkProfile(projectPath, profile);
    if (!resolves.ok)
      return {
        ok: false,
        status: 400,
        error: `${named}'s profile: ${resolves.message}`,
        code: resolves.code,
      };
    return deps.admitSeat(
      projectPath,
      requested.backend,
      requested.modelSelection,
    );
  }

  return async ({ projectPath, request }) => {
    const implementer = await seat(
      projectPath,
      "The implementer",
      request,
      request.profile ?? RUN_SETTING_DEFAULTS.implementer.profile,
    );
    if (!implementer.ok) return implementer;
    const reviewers: ResolvedSeat[] = [];
    const reviewerRequests =
      request.reviewers ?? RUN_SETTING_DEFAULTS.reviewers;
    for (const [index, reviewer] of reviewerRequests.entries()) {
      const resolved = await seat(
        projectPath,
        `Reviewer ${index + 1}`,
        reviewer,
        reviewer.profile ?? DEFAULT_REVIEWER_PROFILE,
      );
      if (!resolved.ok) return resolved;
      reviewers.push(resolved.seat);
    }
    return { ok: true, seats: { implementer: implementer.seat, reviewers } };
  };
}
