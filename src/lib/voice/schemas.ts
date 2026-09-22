import { z } from "zod";

/**
 * Success body returned by the Shama serve API's `POST /transcribe`.
 * `cleanText` is the cleaned transcript CC surfaces to the user; on a
 * `cleanup_fallback` status it carries the raw transcript instead. `status` is
 * left as a free string so a new upstream status value never fails the parse —
 * CC only consumes `cleanText`.
 */
export const transcribeResponseSchema = z.object({
  rawText: z.string(),
  cleanText: z.string(),
  status: z.string(),
  sessionId: z.number(),
});
