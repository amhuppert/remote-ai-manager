## cctl ticket

Manage Command Center **tickets** — durable work items owned by one project,
identified as `<project>#<number>`. The verbs and their exact invocation shapes
are in [the command reference](command-reference.md) (`cctl ticket --help` for the live node);
what follows is what the shapes do not tell you.

**Identifier forms.** A bare `<number>` resolves through the ambient project
scope (`--project` / `CC_PROJECT`); the `<project>#<number>` form addresses any
project's tickets from any conversation — including graph-workflow lanes — and
needs no ambient project. Unknown tickets exit `1` with `ticket_not_found`
naming the reference; malformed references, missing flags, and invalid enum
values exit `2` **before any network call**.

**The bounded list.** `list` leads with `tickets: <n> total, <m> shown` and caps
the rows at 20; when it truncates, the same line names the exact command that
returns the rest (the filters in effect plus `--limit <n>`), and `--json`
keeps rows and omission metadata under `payload.data`. Each row ends with its
`attachments: <count>`, read straight from the list payload — the default costs
exactly one request.

**Disclosure ladder.** Start with `ticket get`. It returns the ticket and
attachment index, at most 20 relationship outlines grouped as parent, children,
depends on, blocks, and related, then the five newest status-update outlines.
Each outline carries a stable id, bounded preview, and exact drill-down command;
the JSON envelope has the same disclosure level and never expands outline
Markdown.

Follow `ticket relation list` or `ticket status-update list` when the ticket
summary reports omitted rows. Both list newest-first, default to 20, cap at 100,
and return `total`/`returned`/`truncated`; a truncated page supplies an opaque
cursor and an exact next command preserving the active role, limit, and cursor.
Use `relation get` or `status-update get` only when the full rationale/body is
needed. Those full reads and `ticket get` apply the 60,000-byte budget separately
to text and JSON: oversized output moves under `.cc/temp/`, and stdout carries
its path, format, byte count, and SHA-256 manifest.

**Relationships.** Interpret every role relative to the first ticket.
`depends_on`/`blocks` and `parent`/`child` are inverse views of one edge;
`related` is symmetric. Resolve both references independently: a bare second
reference uses the ambient project, never the first reference's project, so
qualify both when ambient scope is not intended. Setting a parent atomically
replaces the old parent. Treat dependencies as context, not work gates. Supply
rationales inline or with `--description-file`; use an explicit empty inline
description on `relation update` to clear one.

**Status updates.** Append deliberate progress posts separately from the ticket
status field. Updates have no edit or delete command. Supply Markdown inline or
with `--body-file`. For an authenticated agent call, use the ambient
`CC_CONVERSATION_ID`; the command refuses `--conversation` overrides so the
server can preserve durable source provenance.

**Attachment index.** `ticket get` renders each canonical attachment's id,
kind, description, and exact retrieval command in text and `attachmentIndex` in
`payload.data`. `list --attachments` adds the same bounded index for shown rows, at one
request per shown ticket. `attach` creates four canonical kinds, each with a
required description: file snapshot, conversation compaction snapshot, live
session pointer, or Markdown note. Use `relation add --role related` to link
tickets, and `relation get|update|remove` to inspect or change a relationship.

**Designed friction.** Treat self-link, duplicate-edge, graph-cycle,
same-project hierarchy, and append-only/provenance refusals as deliberate; read
`error.code`, `error.details`, `error.issues`, and `error.why` before changing
the request. Classify silent truncation, missing drill-down handles, lost
structured issues, and help/parser drift as CLI defects rather than constraints
to work around.

```
cctl ticket create --title "Flaky pre-merge gate" --type bug
# → created cc#12  Flaky pre-merge gate
cctl ticket attach file 12 logs/ci-failure.txt --description "full CI log of the flaky run"
cctl ticket list
# → tickets: 34 total, 20 shown — rest: cctl ticket list --limit 34
#   cc#12  not_started  bug  attachments: 1  Flaky pre-merge gate
cctl ticket get 12
# → cc#12  Flaky pre-merge gate
#   status: not_started  type: bug  created: …  updated: …
#   relationships: total=1 returned=1 truncated=false
#   depends on:
#   - rel-3 depends_on — platform#7 [in_progress] API contract
#     get: cctl ticket relation get cc#12 rel-3
#   status updates: total=3 returned=1 truncated=true — next: cctl ticket status-update list cc#12 --limit 20
#   attachments:
#   - id-7 file — full CI log of the flaky run — cctl ticket attachment get cc#12 id-7
cctl ticket relation add cc#12 platform#7 --role depends_on --description-file .cc/temp/rationale.md
cctl ticket status-update add 12 --body-file .cc/temp/update.md
cctl ticket update 12 --status in_progress
```

Related: `cctl conversation compaction get` reads a compaction directly once a
conversation attachment names it; `cctl ticket relation get` and `cctl ticket
status-update get` are the full-content drill-down commands emitted by outlines.

**Bundle transfer.** `ticket export <ticket> --out <path>` writes the exact gzip
bundle and reports its artifact metadata. Import that binary with
`ticket import --archive <path>`; reserve `--file` for structured JSON inputs.
Prepared transfers use `--prepared`; follow the server's digest and omission
acknowledgment requirements. An interrupted preparation or commit has a real
transfer id in recovery; inspect that state before retrying.
