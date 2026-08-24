# Native SDD comment slice technical design (command-center#87)

Status: IMPLEMENTED — commit `f5383ec4`
Date: 2026-08-22
Scope: Native SDD inline comment anchoring, composition, threading, provenance,
placement, actions, and thread-aware counts

## 1. Outcome

Native SDD comments become real review threads without changing their durable
storage model:

- a selection resolves against the rendered Markdown block from which its
  offsets were derived;
- Native SDD offers one honest **Add comment** action and keeps the draft until
  persistence succeeds;
- one thread root produces one highlight and one gutter count, regardless of
  reply count;
- Overview and Review reuse one attributed, actionable thread component;
- agent messages identify their backend when known and link to their source
  conversation;
- historical and unplaceable feedback remains visible; and
- user-facing counts report threads while the existing row metrics retain their
  original meaning.

The database and write routes already carry thread, parent, revision, element,
author, blocking, resolution, and timestamp data. This design preserves that
native model and fixes the read/UI projection that currently discards it.

## 2. Governing inputs

This design refines only the comment slice in
`docs/designs/ticket87-native-sdd-ui-comments-and-attention.md`. It is based on:

- the operator report attached to command-center#87;
- the Native SDD reflection attached to command-center#87;
- the active ticket charter;
- the current Spec Studio, document annotation, review service, and comment
  projection implementations; and
- the Command Center design-system, accessibility, structure, and Tailwind
  conventions.

The operator-reported failures are all confirmed:

| Report | Root cause |
| --- | --- |
| A new comment immediately displays `Stale anchor` | Native stores block-local offsets but Overview reanchors against the entire section body |
| **Add & send** does not send | Native receives the generic two-action composer, but both actions call the same comment mutation |
| Agent replies look like unrelated comments | Overview flattens every row; Review groups rows but renders them as identical sibling paragraphs |
| No agent or conversation attribution | The public view carries author provenance, but both native renderers drop it |

## 3. Goals and non-goals

### 3.1 Goals

1. Preserve native comment identity and lifecycle from the public projection to
   the UI.
2. Resolve inline anchors from the live rendered block, including deferred
   Markdown mounts.
3. Make unsupported actions unrepresentable in the Native call path.
4. Render deterministic, semantically connected threads in Overview and Review.
5. Reuse the existing reply and resolve actions with capability-correct controls.
6. Keep every persisted row discoverable, including invalid legacy provenance,
   removed elements, and historical revisions.
7. Make annotations, gutter counts, status copy, and CLI output thread-aware.
8. Meet keyboard, screen-reader, target-size, mobile, zoom, and sticky-footer
   requirements.

### 3.2 Non-goals

- Moving Native SDD comments into generic document-feedback storage.
- Adding a new comment, reply, or resolve endpoint.
- Adding nested reply chains; native replies remain a flat star under one root.
- Letting a browser supply author provenance.
- Letting agents resolve threads or humans comment on drafts, approved,
  withdrawn, or abandoned revisions.
- Automatically relocating ambiguous quotes.
- Adding a third comments sidebar.
- Changing staged authoring, questions, assumptions, citations, approval carry,
  or any other non-comment slice from the parent proposal.
- A compatibility overload, dual prop contract, dual-write path, old-build
  fallback, or legacy storage adapter.

## 4. Existing authority and defects

### 4.1 Durable authority is already sufficient

`spec_comments` and `SpecCommentRow` already persist:

- `id`, `thread_id`, and nullable `parent_comment_id`;
- `spec_id`, `revision_id`, and `element_id`;
- `anchor_json` and body;
- transport-derived `author_json`;
- `blocking` and `resolution`; and
- creation/update timestamps.

The read projector exposes those fields as `SpecCommentView`, parses human or
agent provenance, and deliberately falls back to `author: null`, `handle: null`,
or `revisionNumber: null` when legacy data cannot be resolved. Existing rows
therefore remain readable without a migration.

The existing actions remain authoritative:

- `comment` creates a human root on a proposed revision;
- `reply` accepts a human or agent, derives revision/element/anchor from the
  root, and never adds another blocking vote; and
- `resolve-thread` is human-only and updates the whole thread while its root
  revision is still proposed.

### 4.2 The client adapters discard authority

Overview maps every native row into `ResolvedComment`, invents generic document
identity and `sent` delivery state, and drops thread, parent, author, revision,
blocking, and resolution fields. Replies copy the root anchor, so one root plus
two replies becomes three highlights, three gutter counts, and three unrelated
cards.

Review retains native rows but assumes the first row is the root, sorts only by
creation time, and renders message bodies without parent, author, timestamp,
conversation, or actions. Threads on quiet unchanged subjects can disappear
because only change and awaiting-approval cards host them.

### 4.3 The shared composer is synchronous

The selection editor invokes a void callback and clears the selection
immediately. `CommentPopover` always renders queue and send actions. A rejected
Native mutation therefore loses the note, while **Add & send** advertises a
capability Native does not possess.

## 5. Target architecture

```text
spec_comments rows
        │
        ▼
projectSpecComment ──► SpecCommentView[]
        │
        ▼
assembleSpecCommentThreads (one canonical root + ordered messages)
        │
        ├──► one annotation source per current, co-located root
        │           │
        │           ▼
        │    live rendered-block resolution
        │           │
        │           ├──► AnnotatedMarkdown highlight + grouped gutter pin
        │           └──► the same anchor state passed to the thread component
        │
        └──► SpecCommentThreadList
                    │
                    ├──► SpecCommentThread presentation
                    └──► existing reply / resolve-thread mutations
```

The design has four knowledge boundaries:

1. `src/lib/specs/comment-threads.ts` owns deterministic native thread assembly
   and row/thread summaries.
2. The shared document-viewer annotation contract owns rendering and composer
   capabilities without depending on `DocumentComment` or `SpecCommentView`.
3. `SpecCommentThread` owns native thread presentation and local reply state.
4. Overview and Review own placement and the exact capabilities available for
   the revision they render.

Spec Studio continues importing the annotation surface through
`src/components/document-viewer/AnnotatedMarkdown.tsx`; it never imports
`src/features/session/**` directly.

## 6. Native thread model

### 6.1 Assembly contract

Add a pure domain module with the following behavioral shape:

```ts
type SpecCommentThreadIntegrity =
  | "valid"
  | "missing-root"
  | "multiple-roots"
  | "invalid-parent";

interface SpecCommentThreadModel {
  threadId: string;
  root: SpecCommentView;
  messages: readonly SpecCommentView[];
  replies: readonly SpecCommentView[];
  open: boolean;
  blocking: boolean;
  resolution: "open" | "resolved" | "dismissed";
  integrity: SpecCommentThreadIntegrity;
}
```

The exact exported names may follow local conventions, but these invariants do
not vary:

1. Group by `threadId`.
2. Sort with one comparator: `(createdAt ASC, id ASC)`.
3. Find roots with `parentCommentId === null`; never infer the root from input
   position.
4. With one root, place it first and sort its replies by the same comparator.
5. Sort threads by their canonical root using the same comparator.
6. Treat a thread as open when any row is open. Treat it as blocking when it is
   open and any row is blocking. This matches the existing service's ended-
   thread predicate and is defensive against partially inconsistent legacy rows.
7. Use the root for quote, anchor, revision, and element. Any open row makes the
   displayed lifecycle **Open**; once no row is open, use the root's resolved or
   dismissed lifecycle.
8. A canonical one-row comment is a valid one-message thread.

Malformed data must remain visible. If no root exists, the earliest row is the
display root. If multiple roots exist, the earliest root is canonical. A row
whose non-null parent is not the canonical root makes the thread invalid.
Invalid threads render in the historical/unplaceable region with **Thread data
incomplete**, emit a warning containing IDs but no body/quote text, and expose no
reply or resolve control. The UI does not silently drop or mutate an ambiguous
thread.

### 6.2 Count contract

Thread summaries are derived, never stored:

| Field | Meaning |
| --- | --- |
| `openCount` | Existing number of open message rows |
| `openBlockingCount` | Existing number of open message rows marked blocking |
| `openThreadCount` | Unique `threadId` groups containing at least one open row |
| `openBlockingThreadCount` | Open thread groups containing at least one blocking row |

Add `openThreadCount` and `openBlockingThreadCount` to `SpecCommentsView` and to
`status.openComments`, while retaining the status object's existing `count` and
`blockingCount` row fields. The new fields are required whenever an
`openComments` object is present; do not invent them from row counts with
per-field defaults. Keep the existing outer
`openComments: ...nullable().default(null)` behavior: absence still means the
optional status enrichment was not supplied, which is an existing contract
outside this slice rather than an old-comment adapter.

Counts remain spec-wide even when `--open` or `--element` filters returned rows.
Status instructions, Spec Studio badges, and human-readable CLI output use
thread counts and say “thread”; JSON continues exposing both row and thread
metrics. Subjects are deduplicated from ordered thread groups, so replies never
repeat a handle.

## 7. Domain-neutral annotation surface

### 7.1 Contract

Add `src/components/document-viewer/annotation-contract.ts` and export its
public types from the existing document-viewer promotion seam.

```ts
type MarkdownAnnotationTone = "active" | "settled";

interface MarkdownAnnotationSource {
  id: string;
  anchor: CommentAnchor;
  tone: MarkdownAnnotationTone;
  accessibleLabel: string;
}

type MarkdownAnchorState =
  | { status: "anchored"; charStart: number; charEnd: number }
  | { status: "reanchored"; charStart: number; charEnd: number }
  | { status: "stale" };

interface ResolvedMarkdownAnnotation extends MarkdownAnnotationSource {
  anchorState: MarkdownAnchorState;
  block: HTMLElement | null; // runtime-only; never persisted or serialized
}

type SpecThreadAnchorState =
  | MarkdownAnchorState
  | { status: "orphaned" };

type MarkdownAnnotationTarget =
  | { kind: "annotation"; id: string }
  | { kind: "block-group"; ids: readonly string[] };
```

`AnnotatedMarkdown` changes atomically from `comments`/`onOpenComment` to:

```ts
interface AnnotatedMarkdownProps {
  // existing document/content/loading fields remain
  annotations: readonly ResolvedMarkdownAnnotation[];
  annotationNoun?: { singular: string; plural: string };
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  composer?: CommentComposerCapability;
}
```

Docs maps pending comments to `active` and sent comments to `settled`. Native
maps open roots to `active` and resolved/dismissed roots to `settled`. The
Recogito bridge and gutter consume only ID, anchor state, runtime block, and
tone; they no longer know `DocumentComment` status or Native lifecycle.

There is no deprecated prop overload. All internal callers update in the same
change, and the native `resolveComment` adapter is deleted.

### 7.2 Live block resolution

Extract the proven live-DOM algorithm from `use-document-comments` into a
generic hook exported through the promotion seam:

```ts
useLiveMarkdownAnchorResolution<T extends MarkdownAnnotationSource>(
  sources: readonly T[],
  content: string | null,
  contentRef: RefObject<HTMLElement | null>,
): readonly (T & Pick<ResolvedMarkdownAnnotation, "anchorState" | "block">)[];
```

Callers attach `contentRef` to an always-mounted ancestor of the deferred
Markdown renderer. The hook:

1. finds candidate stamped blocks by line and section;
2. prefers the deepest candidate, matching selection derivation's nearest-block
   rule (important when a list container and its `li` share source metadata);
3. reads `blockAnnotatableText` rather than Markdown source text;
4. runs `tryReanchorExact` against candidate block text;
5. accepts exactly one matching deepest candidate and otherwise reports stale;
6. labels a shifted result `reanchored` by comparing returned and stored
   offsets;
7. retains the chosen `HTMLElement` so highlighting, gutter measurement, and
   resolution use the same block; and
8. reruns immediately, when sources/content change, and after subtree mutations
   so deferred Markdown mounts resolve before being declared stale.

The observer watches only the rendered subtree. Highlights and gutter pins live
outside that subtree, so the resolver cannot create its own mutation loop.

Native passes one parsed root anchor per current co-located thread. Replies
never become annotation sources. An invalid opaque anchor remains a visible
thread with `stale` state; it is not filtered out.

`orphaned` remains a Native placement state rather than a generic Markdown
state: it means the root's element is absent from the viewed revision. Overview
and Review adapt their result to the concrete `SpecThreadAnchorState` union and
pass that same type to `SpecCommentThread`. Review's existing element-body
resolver already returns this union and remains in use for synthetic Review
anchors.

### 7.3 Gutter activation

Group annotations by their resolved runtime block, not merely by
`line:sectionId`. A gutter group carries all annotation IDs. Its accessible
label uses `annotationNoun`, for example “2 review threads on this passage.”
Its tone is `active` when any grouped annotation is active; it is `settled` only
when every grouped annotation is settled. An unanswered thread therefore cannot
be hidden by a resolved thread on the same passage.

- A highlight emits `{kind: "annotation", id}`.
- A gutter pin emits `{kind: "block-group", ids}`.
- Docs may open the first ID for its existing single-card workflow.
- Native focuses the sole thread article or a labelled `tabIndex={-1}` group
  containing all matching threads.

The pin is at least 24×24px on desktop and 44×44px below 768px, has a canonical
focus-visible ring, and does not scale on hover. Healthy and reanchored roots can
highlight; stale and orphaned roots cannot.

## 8. Capability-based composer

### 8.1 Contract

Replace the discarded `send` boolean with a discriminated capability:

```ts
interface PersistCommentInput {
  anchor: CommentAnchor;
  note: string;
}

type CommentComposerCapability =
  | {
      kind: "persist-only";
      submit(input: PersistCommentInput): Promise<void>;
    }
  | {
      kind: "persist-or-send";
      submit(
        input: PersistCommentInput & {
          delivery: "queue" | "send";
        },
      ): Promise<void>;
    };
```

Native receives only `persist-only`; `delivery: "send"` is not representable in
its branch. Docs receives `persist-or-send` and preserves both actions.

### 8.2 Settlement behavior

Use `mutateAsync` end to end. Submission trims the note, then:

- disables submit, cancel, Escape, outside-pointer dismissal, and scroll
  dismissal while pending;
- keeps the note and selection mounted until the promise settles;
- clears the draft and selection only after success; and
- retains editable text after rejection, marks the input invalid, and announces
  a user-safe error through `role="alert"`.

The selection affordance becomes the trigger for the existing non-modal Radix
`Popover`. The primitive owns dialog semantics, Portal, collision handling,
Escape/outside dismissal, overlay scope, and focus entry/return. Successful
keyboard submission and keyboard cancellation return focus to the selected
source block; a pointer dismissal preserves the pointer target.

For Docs **Add & send**, successful persistence is composer success. If the
subsequent immediate delivery fails, the pending comment already exists; the
composer closes and the existing Docs feedback error/tray presents retry. It
must not retain the composer and risk creating a duplicate pending comment.

Native root composition is available only when all are true:

- the browser is acting as the human transport;
- the rendered revision is proposed;
- the section belongs to that rendered revision; and
- the spec is not abandoned.

The server remains the invariant boundary. Tighten the root input to a null
parent, a valid `CommentAnchor`, and a non-empty trimmed body; inside the same
transaction verify the element is carried by the named proposed revision.
State races then reject before persistence, and the async composer keeps the
operator's draft.

## 9. Native thread UI

### 9.1 Components

Add:

- `SpecCommentThread.tsx`: one presentational thread, local reply form, semantic
  markup, and focus behavior;
- `SpecCommentThreadList.tsx`: deterministic list/group focus and existing
  reply/resolve mutation wiring; and
- `spec-comment-placement.ts`: pure partitioning of co-located versus fallback
  threads for a viewed snapshot and host surface.

`SpecCommentThread` receives the assembled model, one host-resolved
`SpecThreadAnchorState`, and optional async `onReply`/`onResolve` callbacks.
Callback presence is the action capability; the component does not re-derive
lifecycle rules.

The list centralizes `useSpecActionMutation` calls and client logging. Reply
parses a single `SpecCommentRow`; resolve parses `SpecCommentRow[]`. Both rely on
the existing detail-query invalidation and render authoritative refetched
`SpecCommentView` data rather than mutating a local copy.

### 9.2 Presentation

Render one labelled `<article>` per thread with:

- original revision and element handle, falling back to element ID;
- **Open**, **Resolved**, or **Dismissed** lifecycle;
- **Blocking** when applicable;
- the root quote exactly once;
- an ordered message list;
- an explicit screen-reader-visible Root/Reply label per message;
- actor, `<time dateTime>`, and `CompactMarkdown` body for every message; and
- a conversation link on agent-authored messages.

Actor labels are deterministic:

| Provenance | Label |
| --- | --- |
| `{kind: "human"}` | `Operator` |
| known catalog backend | `<Catalog label> agent` |
| agent with missing/unknown backend | `Agent` |
| invalid/legacy provenance (`null`) | `Unknown author` |

Conversation URLs come only from `conversationsPageHref({conversationId})`.
Visible link text is **Open conversation**; its accessible name identifies the
message's agent conversation. The UI never accepts an author from component or
request input.

Show status chips only when they add information: blocking, resolved/dismissed,
reanchored, stale, orphaned, unplaced, or incomplete thread data. Do not render
an `Anchored` chip for a healthy current thread.

The reply rail is a subtle left border and one spacing-step indent on mobile,
not a nested card. Metadata and actions wrap. Add an always-44px `Button` size
to the shared primitive and use it for comment, reply, cancel, and resolve
actions; do not bypass primitive appearance ownership with `layoutClassName`.

### 9.3 Actions and focus

**Reply** is available when the thread is valid, open, and the spec is not
abandoned. It remains available on a historical or withdrawn root because the
existing service deliberately allows conversation to continue after Request
Changes.

**Resolve** is available only when:

- the thread is valid and open;
- the root revision equals the viewed revision;
- that revision remains proposed;
- the spec is not abandoned; and
- the transport is human.

Resolve sends the root revision ID and `resolution: "resolved"`. This slice does
not add a dismiss control.

Opening Reply focuses its labelled `MultilineInput`. While pending, form actions
are disabled and the submitting button is visibly busy. Failure retains the
draft and announces `role="alert"`; success clears/collapses it, announces
`role="status"`, and restores focus to Reply. Cancel restores focus to Reply.
After resolve, focus moves to the updated thread article so removal of the
Resolve button does not strand focus.

Every programmatic thread target has `scroll-margin` sufficient to clear
Review's sticky footer at desktop and its taller stacked mobile layout.

## 10. Placement rules

Every surface assembles all rows once and claims each thread at most once.

### 10.1 Overview

- The viewed revision is `detail.currentRevision`.
- A valid root on a prose-section element in that revision is co-located under
  that section.
- Only roots from the viewed revision become annotations in that section.
- Current structured-element threads remain in Review, where their subject card
  exists.
- Historical roots, removed elements, invalid anchors, invalid thread shapes,
  and current elements that no active host can represent appear once in
  **Historical & orphaned review threads** after narrative content and before
  lint/linked context.

### 10.2 Review

- The viewed revision is the explicitly selected live proposal.
- Current roots co-locate with their subject/change card.
- A current thread on an unchanged subject promotes that subject into an
  unchanged review card even when it has no pending approval.
- A criterion thread is placed in its criterion region within the parent
  requirement card.
- Review continues using `reanchorSpecThread` against element body text; it does
  not use rendered-block resolution for synthetic card anchors.
- Historical, removed, invalid, and unsupported/unplaceable roots appear once
  in **Historical & orphaned review threads** after semantic review content and
  before the sticky action footer.

Fallback entries always display original revision, original handle/element ID,
anchor state, lifecycle, and an explanation when a current thread is merely
unplaceable on that surface. Historical feedback never looks current.

### 10.3 No empty chrome

Do not render an empty comments placeholder, empty historical region, or empty
thread group. Preserve the existing no-empty-comment-placeholder contract.

## 11. Visual and accessibility contract

Desktop:

```text
┌─ REVIEW THREAD · REVISION 4 · R3 ─────────────── OPEN ─┐
│ “the exact selected passage”                           │
│                                                        │
│ ROOT · OPERATOR · Aug 22, 10:14                        │
│ This needs to state the failure behavior.              │
│                                                        │
│   ┃ REPLY · CLAUDE AGENT · Aug 22, 10:18               │
│   ┃ Added the timeout and recovery requirement.        │
│   ┃ Open conversation ↗                                │
│                                                        │
│ [Reply]                                      [Resolve] │
└────────────────────────────────────────────────────────┘
```

Use existing tokens and primitives: `bg-bg-surface`, `border-border-dim`,
`border-border-subtle`, text tokens, `Button`, `StatusChip`, `MultilineInput`,
`Popover`, and `CompactMarkdown`. Add no stylesheet, global CSS, or design
token. Preserve Recogito's vendor stylesheet and the generated-Markdown
descendant contract.

Semantic and interaction requirements:

- each thread is a labelled article;
- messages are an ordered list of list items;
- root/reply relationships do not depend on indentation alone;
- timestamps have machine-readable `dateTime`;
- mutation success uses `role="status"`, failure uses `role="alert"`;
- errors set `aria-invalid` and an input description;
- grouped gutter targets focus a labelled group or sole thread;
- all controls have visible focus indicators;
- ordinary actions are at least 44×44px at every viewport;
- metadata/action rows wrap without horizontal scrolling;
- mobile is verified at exactly 390×844; and
- 200% browser zoom is verified separately from viewport simulation.

The touched session document-viewer files must be registered consistently in
the utility-first ESLint, Prettier class-sort, and utility-collision allowlists.
Spec Studio is already registered. Do not add global CSS or broaden the
allowlists to unrelated legacy files.

## 12. Error handling and observability

The server already emits transition refusals and unexpected mutation failures,
and traced fetch supplies request timing. Client comment logging moves under a
single `spec-studio-comments` logger with stable events:

| Event | Level | Fields |
| --- | --- | --- |
| `spec_studio.comment.root.completed` | info | `specId`, `revisionId`, `elementId`, `threadId` |
| `spec_studio.comment.root.failed` | warn | same IDs plus safe `error` |
| `spec_studio.comment.reply.completed` | info | `specId`, `threadId`, returned comment ID |
| `spec_studio.comment.reply.failed` | warn | `specId`, `threadId`, safe `error` |
| `spec_studio.comment.resolve.completed` | info | `specId`, `revisionId`, `threadId`, updated row count |
| `spec_studio.comment.resolve.failed` | warn | same IDs plus safe `error` |
| `spec_studio.comment.reanchor` | debug | `specId`, `revisionId`, anchored/reanchored/stale/orphaned totals |
| `spec_studio.comment.invalid_thread` | warn | `specId`, `threadId`, integrity code, row IDs |

Never log body text, quotes, selection text, anchor JSON, or conversation
content. Remove `immediateSendRequested`; Native no longer has that branch.

## 13. Data and compatibility impact

There is no database migration, backfill, new endpoint, or comment-store
conversion. Existing single-row comments are already valid single-message
threads; existing replies and agent provenance already round-trip.

This is a coordinated application/API cutover:

- strict view schemas gain required thread-count fields when their enclosing
  object is present; the existing nullable outer status enrichment remains;
- all producers and consumers update together;
- the internal annotation props change atomically;
- no overload preserves `comments`/`onCreateComment`;
- no native-to-`DocumentComment` adapter remains; and
- no compatibility shim, dual-write path, old-build fallback, or old-build
  reader is introduced.

Retaining `openCount` and `openBlockingCount` is not an alias or fallback: those
fields continue reporting their existing row metric. The new fields report a
different, explicitly named thread metric.

## 14. Storybook design gate

Before page integration, implement and review:

### `SpecCommentThread.stories.tsx`

- `FreshOpen`
- `AgentReplyWithConversationLink`
- `MultipleRepliesDeterministic`
- `BlockingOpen`
- `Resolved`
- `Reanchored`
- `Stale`
- `Orphaned`
- `UnknownLegacyAuthor`
- `ReplyOpen`
- `ReplySubmitting`
- `ReplyFailureRetainsDraft`
- `Mobile390`

### Composer/annotation stories

- persist-only composer;
- persist-or-send composer;
- pending submission;
- failure retaining the draft;
- grouped review-thread gutter pin; and
- mixed open/resolved roots sharing one active gutter pin; and
- current versus settled annotation tone.

### Page stories

- Overview root plus agent reply;
- Overview grouped roots and gutter focus;
- threaded Review including a quiet unchanged subject;
- historical/orphaned region; and
- Overview/Review at 390×844.

Every story uses `a11y: {test: "error"}`. Alex reviews the component stories
before Overview or Review integration proceeds.

## 15. Verification matrix

| Behavior | Primary automated evidence |
| --- | --- |
| Reply-before-root and timestamp ties | `src/lib/specs/comment-threads.test.ts` |
| Row counts differ from thread counts | `comment-threads.test.ts`, `route-handlers.test.ts`, `authoring-review-projection.test.ts`, CLI read contract |
| Deepest list block and deferred DOM mount | `anchor-dom.test.tsx`, live-resolution hook test |
| Capability-specific actions and async retention | `CommentPopover.test.tsx`, `AnnotatedMarkdown.test.tsx`, Docs composer integration test |
| One root plus replies produces one annotation | annotation test and `SpecsPage.test.tsx` |
| Thread semantics, author labels, links, focus | `SpecCommentThread.test.tsx` |
| Overview second-block refresh remains anchored | `SpecsPage.test.tsx` |
| Review hierarchy, action bodies, quiet subject, fallback | `SpecReviewMode.test.tsx` |
| Proposed/read-only capability gates | review service and page tests |
| No empty comment chrome | `SpecDetailPrototypeContract.test.tsx` |

Each red-green-refactor loop runs the registered test command scoped to exactly
one test file. Checkpoints run changed format/lint/test plus full typecheck and
architecture seams. Final verification includes Storybook axe, keyboard and
VoiceOver passes, the real app, network/console inspection, and durable comment
and count reads after refresh.

## 16. Acceptance criteria

Implementation is complete only when all are true:

1. A Native comment created in any rendered Markdown block resolves against
   that same live block after refetch and refresh.
2. Native renders only **Add comment**; Docs retains both composer actions.
3. Rejected persistence retains the selection and editable note.
4. One root with any number of replies yields one highlight, one thread, and one
   gutter count.
5. Root and replies render in deterministic hierarchy with actor and time on
   every message.
6. Agent provenance displays a safe backend label and a working conversation
   link; invalid provenance displays `Unknown author`.
7. Reply and Resolve appear only under their specified capabilities and send
   the existing action contracts.
8. Current comments co-locate with narrative/change content; historical,
   orphaned, invalid, and otherwise unplaceable rows remain visible once.
9. User-facing status and CLI copy count threads, while JSON retains explicit
   row and thread metrics.
10. Keyboard, screen reader, 390×844, 200% zoom, target-size, and sticky-footer
    checks pass.
11. No Native comment is converted into generic document-comment storage or
    delivery state.
12. No compatibility shim, fallback path, new global CSS, or new design token is
    introduced.
