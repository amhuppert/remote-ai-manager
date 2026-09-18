import { z } from "zod";

const captureEligibility = z.object({
  eligible: z.literal(true),
  handoff: z.object({
    available: z.literal(true),
    mode: z.enum(["tool-disabled", "instruction-only"]),
  }),
});

/** Bind the authenticated admission disclosure to this probe's capture request. */
export function routeCaptureMode(eligibility: unknown) {
  const parsed = captureEligibility.safeParse(eligibility);
  if (!parsed.success) throw new Error("route fixture capture is not eligible");
  return parsed.data.handoff.mode;
}
