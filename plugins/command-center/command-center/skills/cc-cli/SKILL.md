---
name: cc-cli
description: >-
  Use the cctl CLI for Command Center actions: questions, notifications,
  documents, validation, dev servers, workflows, memory, and conversation
  evidence. Also use when a cctl command fails or its identity, output,
  or asynchronous handoff needs explanation.
---

# Command Center CLI (`cctl`)

Use `cctl` for Command Center actions. The installed binary talks to the running
CC server; it does not execute changes from your branch. Read the relevant
`cctl <group> <verb> --help` before composing a payload or recovering from a
refusal. Help works offline and lists the current flags, schemas, related
commands, and skills. `cctl --help` is the group index.

Use the identity CC injects into this session. Read-only conversation commands
can resolve another conversation by id; cross-session mutations require explicit
scope flags and authorization for that target.

## Choose the relevant reference

Read only the branch needed for the task; command help owns exact invocation
shapes. The complete generated [command reference](references/command-reference.md)
is available when an offline catalog is useful.

| Task | Reference |
|---|---|
| Ask a consequential question; resume an answer | [Questions](references/questions.md) |
| Run registered checks; recover a validation verdict | [Validation](references/validation.md) |
| Start or diagnose a dev server; create CC test fixtures | [Dev servers](references/dev-servers.md) |
| Notify the user; register or delete a document | [Notifications and documents](references/notifications-and-documents.md) |
| Read or update tickets, relationships, attachments, or status posts | [Tickets](references/tickets.md) |
| Recall or capture shared memory | [Memory](references/memory.md) |
| Read transcripts, images, compactions, or continuation checkpoints | [Conversations](references/conversations.md) |
| Author or operate workflows; finish a lane task | [Workflows](references/workflows.md) |
| Read native specs and artifact receipts | [Spec reads](references/spec-reads.md) |
| Submit an authorized Alignment charter or decision batch | [Alignment](references/alignment.md) |
| Delegate a one-shot agent task or inspect agent profiles | [Agents](references/agents.md) |
| Diagnose identity, connectivity, build skew, or help output | [Environment and help](references/environment-and-help.md) |

For plan design, use [graph-workflow-planning](../graph-workflow-planning/SKILL.md).
For native spec authoring and its human gates, use
[native-sdd-authoring](../native-sdd-authoring/SKILL.md).

## Payloads and output

Write JSON payloads under `.cc/temp/` in your assigned worktree, then pass
`--file <path>`. In a restricted workflow context, use the payload or scratch
directory named by its prompt. These locations keep throwaway payloads out of
engine-managed commits. Repair the command's structured validation issues
before resubmitting.

For prose containing quotes, backticks, `$`, or newlines, use the command's
`--<flag>-file` alternative; discover it through leaf help. Pass either the
inline flag or its file variant, never both. This prevents shell expansion from
changing the text the user will review.

Text output is intended for reading; `--json` is for programmatic consumers.
The envelope includes `ok`, optional `error`/`code`/`issues`, command-specific
fields, and the guidance fields below. `--json` changes representation, not
scope: omitted rows stay omitted. Follow returned handles and omission commands
to retrieve needed detail. Full documents can spill to files with a manifest
containing path, format, size, and hash; read or search those files in bounded
chunks. Use byte ranges for a single-line JSON artifact.

When parsing output, redirect it to a file first instead of piping a potentially
large response through another process. Some commands, including validation,
append runner output after their JSON envelope; decode the first JSON object
and inspect its outcome rather than assuming the entire stdout is JSON.

## Output tiers

| Field | Meaning | Action |
|---|---|---|
| `hint` | Advisory next step | Use it when relevant; it grants no authority and imposes no gate. |
| `reminders[]` | State-dependent invariants | Keep them true while continuing the authorized work. |
| `instruction` / `stopInstruction` | Immediate protocol action | Follow it before the next tool call, subject to higher-priority instructions. |

A successful `cctl ask` or `cctl decisions propose` registers an asynchronous
human handoff. Give a brief note explaining what is pending, then end the turn;
the answer arrives in a later prompt. An already-pending question also means
end the turn. Prepare working notes before submitting. An autonomous-turn
refusal means use best judgment within the authorized scope.

Workflow lane commands may also require ending the turn for a halt,
collaboration, or context rotation. Follow the explicit instruction; consult
the workflow reference for the command's continuation contract.

## Exit codes

<!-- BEGIN GENERATED EXIT CODES -->
_Generated from the CLI exit taxonomy. `cctl exit-codes` prints the same table offline._

| Code | Meaning | Recovery |
|---|---|---|
| `0` | the command did what was asked | — |
| `1` | the server refused the operation, or a server-side job it started failed | — |
| `2` | a local flag, identity, or payload check failed before any request was sent | `cctl <command> --help` |
| `3` | the CC server could not be reached, or it rejected the API token | `cctl doctor` |
| `4` | this binary and the server are different builds — nothing changed unless the failure text warns the mutation may have committed | `cctl doctor --server <url>` |

<!-- END GENERATED EXIT CODES -->

Errors lead with an actionable line on stderr. Exit `4` is a build mismatch:
run `cctl doctor` and use the binary the intended server publishes. If the
failure warns that a mutation may have committed, read durable state before
retrying. Diagnose `3` with `cctl doctor`; inspect leaf help and payload issues
for `2`. An exit `0` can still represent a documented no-op or a status read of
a failed job, so verify the command-specific outcome before reporting success.

Finish once the authorized action has a success receipt and any necessary
state check confirms its result. For an asynchronous launch, report the run id
and current state; claim completion only after its terminal success result.
