/**
 * Manual collaboration is session-scoped by decision, not by accident: a collab
 * workflow needs a session branch and worktree to negotiate and land changes in,
 * and a project conversation executes directly in the shared project root.
 *
 * The refusal has to be the project boundary's own, and explicit. Delegating a
 * `/collab` prompt to the shared driver instead reached the collaboration
 * manager with this entry's synthetic sentinel session, whose session lookup
 * failed with `Session "__project__" not found` — publishing the internal
 * sentinel in an SSE error and disguising a scope decision as a missing record.
 */
export class ProjectCollaborationUnsupportedError extends Error {
  readonly statusCode = 400;
  readonly code = "PROJECT_COLLABORATION_UNSUPPORTED";
  constructor() {
    super(
      "/collab is not available in a project conversation — manual collaboration needs a session branch and worktree. Start a session for this project and run /collab there.",
    );
    this.name = "ProjectCollaborationUnsupportedError";
  }
}
