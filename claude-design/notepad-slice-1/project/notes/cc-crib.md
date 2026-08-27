# CC recreation crib sheet (distilled from command-center repo)

## Load in every DC helmet
fonts.css, _ds_bundle.css, styles.css from _ds/design-system-002d1d37-29da-4794-bb0a-ed0e4310c5f8/
Legacy var names all exist: --bg-void/base/surface/raised/elevated/hover, --border-dim/subtle/default/strong,
--cyan(-dim/-glow/-glow-strong/-glow-text), --amber(-dim/-glow), --green(-dim/-glow), --red(-dim/-glow/-text #e8506c),
--violet(-dim/-glow/-glow-strong), --text-primary #dce2f0 /secondary #7b899f /tertiary #738699 /inverse,
--font-display(Anybody)/body(Manrope)/mono(Geist Mono), --space-2xs..3xl (2/4/8/12/16/24/32/48),
--radius-sm 4/md 6/lg 10, --topbar-height 48px.

## Shell
- Topbar: sticky h48, px-lg, bg rgba(11,16,25,.85) blur(16px) sat(140%), border-b subtle. Logo "CC" Anybody 800 1.1rem cyan text-shadow 0 0 20px cyan-glow-text. Divider 1×20 border-default. Breadcrumb mono .8rem secondary; .bc-session primary 600.
- Body bg --bg-void. Session layout: topbar / info strip / content grid / composer. Content split layout: grid-cols 1fr 1fr, transition 250ms.

## SessionInfoStrip (below topbar)
bg-bg-base, border-b border-default, mono .72rem, px-md py-6px, flex gap-x-lg items-center.
Items: worktree CopyableId (label lowercase tertiary + mono value secondary, max-w 300 truncate) | 1×16px separator bg-border-default | status: 6px dot (cyan pulse glow) + UPPERCASE tracking .05em secondary text | context fill | right: chips, layout switcher.

## ConversationPanel (left column)
.prompt-panel bg-bg-surface. Header: flex gap-sm px-lg py-md border-b, claude: bg linear-gradient(90deg,var(--cyan-glow),var(--bg-base) 55%), border-b rgba cyan a18.
AgentPill: pill mono 600 lowercase .68rem px-8 py-2 gap-5, cyan: bg-cyan-glow text-cyan border cyan-glow-strong; dot 6px bg-current shadow 0 0 6px currentColor. Title .92rem sans 600 primary truncate. "N messages" mono .7rem tertiary. Right: ConversationNav (28px icon btns: border border-default radius-sm bg-transparent text-secondary, hover bg-hover text-primary border-strong).
Body: p-lg, messages column.

## Message rows
Role label: mono .7rem 700 uppercase tracking .1em mb-6px; user "You" amber; assistant "claude" cyan (codex violet). Timestamp: " · 14:32" .7rem 500 normal-case tertiary.
Content: Manrope .9rem lh 1.65 primary. Row padding-bottom 24px.

## Prompt composer (bottom)
.prompt-input-area: border-t border-subtle bg-bg-base px-lg py-md; inner flex-col gap-sm.
Editor box: rounded-md border border-default bg-bg-surface px-14 py-12 mono .85rem lh1.5 primary, min-h 80, focus-within border-cyan-dim + shadow 0 0 0 3px cyan-glow. Placeholder tertiary.
Toolbar: flex justify-between. Left: 36px attach btn (border-subtle radius-sm text-secondary hover border-cyan-dim), backend toggle, model select etc (mono .78rem pill/selects). Right: send btn 36px rounded-md bg-cyan text-inverse "▶".

## Editor mention chips (Tiptap) — TicketMentionChip pattern
span inline-flex items-center gap-4 rounded-md border border-border-default bg-bg-raised py-2 pr-4 pl-6 mono .78rem leading-none; selected: border-cyan-dim shadow 0 0 0 2px cyan-glow. Glyph 12px stroke 1.2 text-cyan. Label text-primary. Remove ×: 16px text-tertiary hover bg-red-glow text-red-text.
ImageMarkerChip: same + 20px thumb rounded-3, "#N" cyan 600.
Transcript ref chip (pill): inline-flex gap-5 rounded-full border px-sm py-2xs mono .7rem lh1.4; spec-style: border cyan a25 bg-cyan-glow text-cyan; element-style: border-default bg-raised text-secondary.

## Right pane
Tab bar: rounded-t-lg border (no bottom) border-subtle bg-bg-surface px-md py-sm. TabsList: flex gap-2px p-3px bg-bg-surface border border-default rounded-md. Tab: min-h 28 px-10 py-5 rounded-sm mono .72rem 500 uppercase tracking .05em text-secondary; active bg-cyan text-inverse; hover bg-bg-hover text-primary. Panel body: border border-subtle (no top) rounded-b-lg bg-bg-surface, fills column.
Tabs today: Diff Docs Alignment Specs Artifact (+ Notepad = 6th).

## Reference picker popup (above composer)
Shell: absolute bottom-full inset-x-0 rounded-t-lg border(no bottom) border-default bg-bg-surface mono, shadow up, top 1px line gradient(transparent, cyan 20-80%, transparent) opacity .6, max-h 420.
Header: sticky bg-bg-raised border-b subtle px-sm py-xs .7rem tertiary; left UPPERCASE 600 tracking .06em label; right count secondary.
Scope tabs row: bg-bg-surface border-b subtle px-sm pt-xs; tab: border-b-2 px-sm pt-3 pb-5 mono .72rem 600; active border-b-cyan text-primary + count colored (cyan/amber ticket/violet spec); inactive border-transparent text-tertiary.
Section header row: bg-bg-raised px-sm py-3 .68rem 600 tracking .08em tertiary uppercase, right hint normal-case.
Item row: min-h 32 px-sm py-xs gap-sm border-l-2 transparent; active: border-l-cyan bg-bg-hover + overlay gradient(90deg, cyan-glow 0%, transparent 60%); glyph 13px (file secondary/conversation cyan/spec violet/ticket amber); idLabel .7rem 600 cyan; label .78rem 500 primary (match chars cyan); desc .72rem tertiary truncate; status dot 6px + .7rem label; meta .68rem tertiary right.
Footer: sticky bg-bg-raised border-t subtle px-sm py-xs .7rem tertiary, kbd: border border-default bg-raised rounded-sm px-4 .7rem secondary.

## StatusChip
pill px-8 py-2 mono .7rem 500 lh1.3 gap-4. neutral: border-subtle text-tertiary; cyan/amber/green/red/violet: border {tone} a25 + bg {tone}-glow + text {tone}. ghost: dashed border-default text-secondary hover cyan.

## Markdown preview (intent "document"-ish, use compact-ish sizes in narrow pane)
Root: Manrope .9rem lh1.65 primary. h1 1.3-1.5rem bold border-b subtle pb-sm (document) font-body; message intent uses font-display headings. p mb-sm/md. ul: '›' cyan bold markers, pl-lg. task list: checkbox. blockquote: border-l-3 cyan bg-raised px-md py-sm rounded-r-sm text-secondary (document). code inline: bg-raised px-.4em text-cyan .82em rounded-sm. pre: bg-bg-base border subtle rounded-md p-md mono .8rem. table: th bg-raised mono .75rem 600 secondary, borders subtle, even rows bg-raised. hr border-subtle. links cyan underline. img rounded-md.
Diff marks: ins bg-green-glow text-green rounded-sm; del bg-red-glow text-red-text line-through.

## Buttons
Primary: bg-cyan text-inverse rounded-md mono; default: bg-surface border default; ghost: transparent text-secondary hover primary. Icon btn 28px border-default radius-sm.
Send btn: 36px bg-cyan rounded-md hover bg-cyan-dim + glow shadow.

## Voice/critical rules
mono everywhere except message prose + notepad preview prose (Manrope). No emoji, SVG 1.5 stroke icons. UPPERCASE labels for counts/sections. No cyan bg for selection (elevation+border instead). Hover +1 elevation. Focus: 2px cyan outline offset 2. 0.15s ease. Text floor 0.7rem. Amber=awaiting, green=success, red=destructive, violet=codex only, cyan=active.
Empty state: Anybody title, mono .78rem secondary body, centered.

## Reference XML forms (registry)
conversation-ref / ticket-ref / message-ref / spec-ref / requirement-ref / decision-ref / task-ref / question-ref / assumption-ref (+ notepad-ref new). Attrs incl project-name, ids, read-command e.g. "cctl ticket get 90". Ticket id format like "CC-90". Spec handles R1/D2/T3.
Picker triggers: @ / # / ! ; groups: Conversations, Tickets, Messages, Specs, Requirements, Decisions, Tasks, Questions, Assumptions. Filter chips Alt+D done (green), Alt+A archived (amber). Footer: ↑↓ navigate · Tab scope · Enter select · → complete · Esc close.

## Layout facts
Split layout = 50/50 grid (session-content-area data-layout=split). Right pane hidden in "conversation" layout. Tokens doc says right-pane 340px (legacy). Topbar 48. ≤1180 right pane hides.
