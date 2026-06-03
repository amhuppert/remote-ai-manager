/**
 * CC orientation appended to a project conversation's system prompt. Unlike the
 * session-scoped `CC_CONTEXT`, this omits any dev-server promise: a project
 * conversation runs in the repo-root (main) worktree where the per-session
 * dev-server machinery has no meaning. It also makes the main-worktree
 * execution context explicit so the agent knows it has full read/write on the
 * repo root without a session branch.
 */
export const PROJECT_CC_CONTEXT =
  "<command-center>You are running inside Command Center (CC), a web-based control plane for managing remote Claude Code sessions. This is a project conversation: your turns run directly in the project's main (repo-root) worktree with full read/write — there is no isolated session worktree or branch for this conversation, and CC does not merge its changes. CC provides a notification tool to send push notifications to the user's phone when warranted (e.g., long tasks complete, user asked to be notified).</command-center>";
