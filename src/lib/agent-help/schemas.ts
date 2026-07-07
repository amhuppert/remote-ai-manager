/**
 * Schemas for the dynamic help-context endpoint (docs/design/cc-cli/04 §4.2).
 *
 * `GET /api/agent/help-context` returns server-rendered `context:` blocks that
 * the CLI appends to static `--help` best-effort. The response is deliberately
 * tiny — at most 3 blocks, each a short title + body — because help must stay
 * boring: unpredictable help is worse for agents than static help.
 */
import { z } from "zod";

/** One dynamic help-context block, rendered under a command's `context:` section. */
export const helpContextBlockSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type HelpContextBlock = z.infer<typeof helpContextBlockSchema>;

/** The endpoint response. The service caps `blocks` at 3 (docs/design/cc-cli/04 §4.2). */
export const helpContextResponseSchema = z.object({
  blocks: z.array(helpContextBlockSchema),
});
export type HelpContextResponse = z.infer<typeof helpContextResponseSchema>;

/**
 * The query params of `GET /api/agent/help-context`. `command` is the
 * space-joined command path (e.g. "workflow create"); the identity params are
 * the standard CLI identity, forwarded so a provider can scope its answer to the
 * calling session/conversation/lane.
 */
export const helpContextQuerySchema = z.object({
  command: z.string().min(1),
  project: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  conversation: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
});
export type HelpContextQuery = z.infer<typeof helpContextQuerySchema>;
