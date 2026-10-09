import { z } from "zod";

// Kept apart from the run schemas: every page's event listener parses it, and
// should not load the whole run page contract to do so.

/**
 * Something a run's page shows changed: its record, or one of its Contexts.
 * Id-only, so a client refetches the run's page and its session's run list.
 */
export const runChangedEventSchema = z
  .object({
    type: z.literal("run-changed"),
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type RunChangedEvent = z.infer<typeof runChangedEventSchema>;
