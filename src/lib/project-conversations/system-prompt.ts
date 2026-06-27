import { SPAWN_PROPOSAL_FENCE } from "@/lib/chat-spawning/proposal-validator";

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

/**
 * Project-conversation-only instruction teaching the agent the spawn-proposal
 * convention: it can *propose* new CC sessions (each its own branch + worktree)
 * for the user to create from an interactive card, but never creates them
 * itself (agent-offloading — the agent emits validated data, CC acts). The
 * fenced block tag is sourced from `SPAWN_PROPOSAL_FENCE` so the prompt and the
 * `extractProposal` parser can never drift. This is appended ONLY for project
 * conversations (see `actor-implementations.ts`), never for session agents,
 * which cannot spawn sibling sessions from a conversation.
 */
export const PROJECT_SPAWN_INSTRUCTIONS = [
  "<spawning-sessions>",
  `From this project conversation you can PROPOSE new Command Center sessions for the user to create — you never create them yourself. When the user wants to parallelize work or spin it out into separate isolated sessions (each gets its own git branch and worktree), describe the plan in prose, then emit exactly one fenced \`${SPAWN_PROPOSAL_FENCE}\` code block containing a JSON object. CC renders the block as an interactive, editable card with a Create button; the user reviews, edits, and creates the sessions.`,
  "",
  "Wire shape (one object, `sessions` is a 1–20 element array):",
  "```" + SPAWN_PROPOSAL_FENCE,
  "{",
  '  "sessions": [',
  "    {",
  '      "name": "concise-human-name",',
  '      "target": "main",',
  '      "agent": "claude",',
  '      "mode": "normal",',
  '      "initialPrompt": "Optional first instruction for the new session\'s agent."',
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "Field rules:",
  "- `name`: required, non-empty. CC auto-derives each session's git branch from this name (the same slug + prefix the New Session dialog uses) — do not propose a branch.",
  "- `target`: merge-target branch; defaults to `main` when omitted.",
  "- `agent`: `claude`, `codex`, or `dual` (a Claude+Codex race on the same task).",
  "- `mode`: `normal` (you write the first turn / leave it idle) or `optimistic` (CC seeds the kickoff prompt from `initialPrompt` and the agent runs autonomously).",
  "- `initialPrompt`: optional. Include it to auto-dispatch the new session's first turn; omit it to create the session idle.",
  "",
  "Only emit the block when you are actually proposing sessions, and emit it once per proposal. Do not claim the sessions exist or that you created them — they do not exist until the user clicks Create on the card.",
  "</spawning-sessions>",
].join("\n");
