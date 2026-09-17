import type { z } from "zod";
import { laneIdentitySchema } from "./schemas";

export const LANE_IDENTITY_HEADER = "x-cc-lane-identity";

export type LaneIdentity = z.infer<typeof laneIdentitySchema>;
export type LaneIdentityReading =
  | { kind: "valid"; scope: LaneIdentity }
  | { kind: "absent" }
  | { kind: "invalid"; reason: "malformed" };

/** Current execution and conversation binding are checked again before mutation. */
export function encodeLaneIdentity(scope: LaneIdentity): string {
  return JSON.stringify(scope);
}

export function readLaneIdentity(
  raw: string | null | undefined,
): LaneIdentityReading {
  if (!raw) return { kind: "absent" };
  try {
    const parsed = laneIdentitySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { kind: "valid", scope: parsed.data };
  } catch {
    // An unreadable agent identity must not fall through to the human UI.
  }
  return { kind: "invalid", reason: "malformed" };
}
