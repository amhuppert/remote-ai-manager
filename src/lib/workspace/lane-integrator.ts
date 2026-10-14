import type { LaneTarget } from "./schemas";

/**
 * Brings a lane up to date with the session before it publishes: merges the
 * captured session head into the lane branch and gets the lane's publication
 * checks passing there. An integrator may resolve conflicts and fix failures
 * itself; whatever it does lands as commits on the lane branch, never on the
 * session.
 */
export interface LaneIntegrator {
  integrate(input: {
    lane: LaneTarget;
    /** The session head captured for this attempt; publication requires it unchanged. */
    head: string;
    checks: readonly string[];
    cause: string;
    signal: AbortSignal;
  }): Promise<{ kind: "integrated" } | { kind: "failed"; detail: string }>;
}
