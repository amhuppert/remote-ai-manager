import {
  agentBackendIdShapeSchema,
  type AgentBackendId,
} from "@/lib/shared/schemas";

/**
 * The Cursor backend id, minted once for the whole adapter.
 *
 * It is parsed through the shape schema rather than written as a literal
 * because the canonical enum admits `cursor` only when the registration slice
 * lands (spec D4), and that slice is deliberately one reviewed change. The
 * shape schema exists for exactly this: it validates the id's shape and leaves
 * membership to registry resolution, so the adapter can name itself without
 * a cast and without half-registering the enum.
 */
export const CURSOR_BACKEND_ID: AgentBackendId =
  agentBackendIdShapeSchema.parse("cursor");
