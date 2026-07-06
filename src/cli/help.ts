/**
 * Per-command help text for `cctl <command> --help`. Condensed from the
 * cc-cli skill (plugins/command-center/.../skills/cc-cli/SKILL.md), which
 * remains the full reference — keep the two in sync when commands change.
 */

const COMMAND_HELP: Record<string, string> = {
  ask: `usage:
  cctl ask --file questions.json
  cctl ask --question "<text>" --option <label> --option <label> [--multi-select] [--header "<h>"] [--context "<c>"]

Register a question batch for the user, then END YOUR TURN — the answers
arrive as your next user message. --file takes {"questions":[...]}.
`,
  notify: `usage:
  cctl notify "<message>" [--title "<title>"]

Send a push notification to the user. Exit 1 (non-fatal) when push is
unconfigured.
`,
  docs: `usage:
  cctl docs register <path> --description "<why it matters>"
  cctl docs list [--json]
  cctl docs delete <id>

Manage this session's reference documents.
`,
  dev: `usage:
  cctl dev list [--json]
  cctl dev ensure [<serverName>]
  cctl dev stop <serverName>

Manage this session's dev servers. \`ensure\` starts the server if needed and
blocks until it is running, printing the localUrl/remoteUrl to drive.
<serverName> may be omitted when exactly one server is configured.
`,
  fixture: `usage:
  cctl fixture session create <project> [--name <n>] [--dev <serverName>] [--target <url>] [--skip-warm]
  cctl fixture session delete <project> <sessionName>
  cctl fixture prompt <project> <sessionName> --text "<prompt>" [--conversation <id>] [--wait [--timeout <sec>]]
  cctl fixture status <project> <sessionName>

Scaffold live-test state against this session's WORKTREE DEV SERVER (auto-
resolved via 'cctl dev'; never the managing CC instance). \`session create\`
returns a ready conversation id, deep-link URLs, and the dev DB/transcript
paths, and pre-warms the routes so the first browser navigation is fast.
\`prompt --wait\` runs a real turn and blocks until it completes.
`,
  workflow: `usage:
  cctl workflow validate --file plan.json [--json]
  cctl workflow create --file plan.json [--json]
  cctl workflow replace <id> --file plan.json [--json]
  cctl workflow list|get <id>|status|start <id> [--file inputs.json]|delete <id>
  cctl workflow templates [--tier global|project] [--json]

Lane-only verbs (inside graph-workflow lane conversations):
  cctl workflow task complete <taskId> --summary "<what changed, how verified>"
  cctl workflow task add --title "<name>" --instructions "<steps>" [--slug <slug>]
  cctl workflow shared-doc upsert <relativePath> --file doc.json
  cctl workflow collab request --brief "<question with context>"
`,
  charter: `usage:
  cctl charter write --file charter.json

Submit the session's Alignment charter for the user's approval.
`,
  decisions: `usage:
  cctl decisions propose --file decisions.json

Propose decisions for the user's review. decisions.json is
{"decisions":[{"statement":"...","rationale"?,"context"?}]}.
`,
  codex: `usage:
  cctl codex run --file prompt.json [--wait [--timeout <dur>]] [--json]
  cctl codex status <runId> [--json]
  cctl codex cancel <runId>

Run OpenAI Codex as a one-shot sub-agent in this worktree. prompt.json is
{"prompt":"<task>"}. Job-shaped: without --wait, poll with \`status\`.
`,
  conversation: `usage:
  cctl conversation read <conversation-id> [--outline] [--message N] [--message-range A:B] [--include-tools none|summary|full] [--include-thinking]
  cctl conversation compact <conversation-id> [--message N] [--force] [--wait] [--json]
  cctl conversation compaction get <conversation-id> [--message N] [--format json|markdown] [--json]
  cctl conversation compaction list <conversation-id> [--json]

Read other conversations' transcripts and manage compaction artifacts.
Prefer \`compaction get\` before \`read\` — it is the cheap summary.
`,
  doctor: `usage:
  cctl doctor

Check connectivity, auth, and build parity with the CC server. Run it first
whenever any cctl command exits 3.
`,
  version: `usage:
  cctl version

Print the cctl build stamp.
`,
};

export function helpFor(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}
