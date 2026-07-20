# Quick Ticket & CC Bug Report — UX Direction (v1)

Status: direction approved-in-principle via question round 2026-07-19 (batch q_def497dc). Detailed UI design is delegated to Claude Design; this document is the UX/architecture direction that the Claude Design prompt and the implementation spec derive from.

## Goal

Frictionless ticket capture from anywhere in Command Center: an idea or bug observation arises mid-work, the user opens a dialog, confirms prefilled context, hits Create, and is back in their flow in seconds. A specialized mode turns the same dialog into a Command Center bug report that self-assembles the diagnostic context an implementing agent needs to understand, reproduce, and fix the bug.

## Locked decisions (Alex, 2026-07-19)

1. **Entry points**: persistent topbar button + global keyboard shortcut. No conversation-local affordance.
2. **Dialog shape**: one canonical dialog — evolve the existing `CreateTicketDialog` (src/features/tickets/components/CreateTicketDialog.tsx) into a context-aware surface used by every creation path, including the /tickets page.
3. **CC bug variant**: a mode switch inside the dialog. Must resolve "the Command Center project" portably — other machines have the CC repo at different paths (see §6.1).
4. **Diagnostic bundle**: all seven items — route + view state, identity IDs + deep links, conversation attachment, cctl command crib, server build/environment, screenshot, recent client errors.
5. **Assembly**: hybrid — deterministic bundle at create time (instant), background agent enrichment afterwards.
6. **Conversation link**: attach at create, compaction snapshot generates in the background.

## 1. Entry points and availability

- **Topbar button** — a compact "New ticket" affordance in the global topbar near the breadcrumb switchers. Rendered on every page except excluded global pages.
- **Global hotkey** — registered in `HOTKEY_REGISTRY` (src/lib/shared/hotkeys.ts) so it appears in the `?` help modal. Candidate: `mod+shift+t`; vet against existing bindings (hotkey-helper) before locking. Suppressed while another overlay is open (existing `useOverlayScope` behavior).
- **Availability**: everywhere except special global pages — v1 exclusion list is the config/settings surface only. On global-but-allowed pages (/tickets, /workflows, /conversations without a selection) the dialog opens with no project prefill.
- The /tickets page's existing "New ticket" button opens this same dialog (no navigation-on-success behavior change there beyond §3).

## 2. Context prefill

Derived from the current route and client state at open time:

- **Project**: the project owning the current page (project page, session page, conversation in a project session). Empty on pages with no project context — user picks explicitly; never guess.
- **Proposed conversation link**: when a conversation is active in view (conversation page, session page with selected conversation, /conversations?c=…), the dialog shows it as a removable chip in a "Context" section. One click removes it; it never blocks create.
- Prefill is a proposal, not a constraint — every field stays editable.

## 3. Create flow (generic mode)

- Fields: project, type, title, description (existing schema; no new ticket fields).
- Create is **instant and deterministic** — no LLM in the path. On success: dialog closes, toast with "View ticket" link (`ticketDetailHref`), user stays exactly where they were. The quick flow never navigates away (the /tickets-page invocation may keep its current navigate-to-detail behavior or adopt the toast — Claude Design's call).
- If the kept conversation chip survives to create: the conversation is attached via the existing attachment mechanism and its compaction snapshot generates in the background (semantics of `cctl conversation compact` without `--wait`). A failed snapshot must be visible on the ticket with a retry affordance — not silent.
- **Draft preservation**: accidental dismissal (Esc/outside click) with dirty fields must not lose text. Either confirm-before-discard or in-memory draft restore on reopen; Claude Design picks the interaction.

## 4. CC bug report mode

A mode switch inside the dialog (e.g. segmented "Ticket | CC bug report" — exact form is Claude Design's). Flipping to CC-bug mode:

- Retargets the ticket to the resolved Command Center project (§6.1) and sets type=bug. The context captured still points at the project/session/conversation where the bug was observed.
- Reveals a **diagnostic bundle panel**: every auto-captured item listed visibly before submit — nothing is attached invisibly. Items are individually removable (checkbox or chip-dismiss).
- Title/description stay the user's own words; the bundle carries the machine context.
- If the CC project cannot be resolved on this instance, the mode switch is disabled with an explanatory tooltip (how to configure it), not hidden.

## 5. Diagnostic bundle (deterministic layer)

Assembled client+server at create time from known state. Mapping to existing attachment kinds:

| Item | Form |
|---|---|
| Route + view state | Part of one **metadata note attachment**: URL/route, params, selected conversation, active pane/tab summary — bounded, no full store dumps |
| Identity IDs + deep links | Same note: project, session name, conversation ID(s), active workflow execution ID; each with a CC deep link |
| Server build + environment | Same note: server build stamp/git SHA (what `cctl doctor` reports), app version, platform |
| cctl command crib | Same note: ready-to-run block — `cctl ticket get <ref>`, `cctl conversation read <id> --outline`, `cctl conversation compaction get <id>`, attachment-index retrieval commands, debug-log pointers |
| Conversation attachment | Existing conversation attachment kind (compaction snapshot, background per §3) |
| Screenshot | **File attachment** (existing file-snapshot kind). Captured client-side when the user flips to CC-bug mode, excluding the dialog overlay itself; thumbnail preview in the bundle panel. Recommended technique: DOM-render capture (html-to-image family — no permission prompt, can exclude the overlay subtree), accepting fidelity limits for canvas/video content; `getDisplayMedia` rejected for its per-capture permission prompt. Final technique choice is an implementation decision |
| Recent client errors | Same note or a second note: last N entries from a **new client-side error ring buffer** (window.onerror, unhandledrejection, console.error, failed requests) with timestamps; bounded, secret-free |

One consolidated metadata note keeps the attachment index readable; the crib block is what makes the ticket agent-navigable in line with the tickets-as-progressive-disclosure model.

## 6. New infrastructure

### 6.1 Command Center project resolution (cross-machine)

Tickets are per-instance (configDir `command-center.db`), so resolution is a per-instance runtime concern, not a data-portability one. Resolution order:

1. **Config override** — an explicit setting (instance config or the project's `CommandCenter.json`) marking which registered project is Command Center itself.
2. **Auto-detect** — the server matches a registered project's path against its own repo root (the server knows where it runs from).

Unresolved → CC-bug mode disabled with guidance (§4). This keeps the feature working on any machine regardless of where the CC repo lives or what the project is named there.

### 6.2 Client error ring buffer

Small always-on client module; bounded (e.g. last 20 entries); read at bundle-assembly time. New machinery — scope it minimally, no persistence.

### 6.3 Screenshot capture

Client-side DOM-render capture, triggered on mode flip (not eagerly on every dialog open), overlay excluded. Removable from the bundle before submit.

### 6.4 Global mount + hotkey

Dialog state hoisted to the root layout (alongside existing global overlays) so any page can open it; new registry entry for the hotkey.

## 7. Background work after create

Two independent background tracks, both visible on the ticket rather than silent:

1. **Compaction snapshot** for the attached conversation (existing machinery, async).
2. **Agent enrichment pass** (CC-bug mode; potentially generic mode later): a server-side job runs a one-shot agent against the fresh ticket. The agent reads the deterministic bundle via `cctl ticket get`/`attachment get`, then **appends** — an "Agent triage" note attachment and/or additive description sections (repro hypothesis, suspected area, related code pointers). It never overwrites user-authored text. Ticket UI shows enrichment state (pending/running/failed-with-retry). Flows through the existing jobs/notifications publication path (.kiro/steering/notifications.md).

## 8. Open items

- Exact hotkey combo (vet `mod+shift+t` with hotkey-helper against registry + OS/app bindings).
- Screenshot capture library/technique final call (html-to-image vs alternatives) — behind the UX either way.
- Enrichment agent backend/model/effort defaults, and whether generic-mode tickets also get optional enrichment.
- Config override shape for §6.1 (instance config vs `CommandCenter.json` field) — decide during spec.
- Whether /tickets-page creation adopts toast-on-success or keeps navigate-to-detail.

## 9. Next step

Draft the Claude Design prompt for the dialog prototype: canonical dialog with context chips, mode switch, diagnostic bundle panel with removable items + screenshot thumbnail, toast confirmation. The prompt should hand over this document's §§1–5 plus the cc-design-system constraints.
