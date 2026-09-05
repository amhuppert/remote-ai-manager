# Command Center mobile display audit

Audited and implemented on 2026-09-05 in `fix-mobile-gaps-and-issues-6fdfdc`.

## Findings and fixes

| Area | Issue | Result |
| --- | --- | --- |
| Conversation navigation | Alignment, Memory and Compactions had no mobile entry. Six persistent panel buttons also crowded the bottom bar. | Chat, Diff and Docs remain direct actions. More opens Alignment, Memory, Compactions, Notepad, Specs and Info; its label identifies the selected secondary panel. |
| Conversation layout | Mobile panel selection and the desktop right-pane selection could disagree. The desktop panes layout prevented secondary mobile panels from opening. | Panel selection is synchronized in the store. Phones render one selected panel even when the saved desktop layout is panes. |
| Empty conversation tabs | Closing every tab made secondary session panels inert. | Mobile session panels remain accessible with no tabs open; Chat retains the add-conversation empty state. |
| Compaction | Mobile users could neither generate/view an artifact nor reliably navigate back from an artifact source reference. | Compactions exposes the existing artifact UI. A source reference selects Chat and navigates to the referenced message. |
| More sheet | The custom overlay did not contain keyboard focus or reliably return it to the opener. | The existing Dialog primitive supplies focus containment, Escape, outside dismissal and focus return. The sheet scrolls in short viewports. |
| Session actions | Rebase and some session information/configuration were absent on mobile. | More includes Rebase, Dev Servers, TDD and Delete. Info includes the profile and session capabilities. |
| Session information | Branches, paths and identifiers were truncated; copy rows lacked native keyboard interaction. | Values wrap, and copy rows are native buttons. Info hides when returning to desktop width. |
| Bottom bar and content height | Small buttons and mismatched clearance could crowd or cover content near the home indicator. | Primary controls have 44px touch targets. Bar height and content clearance include the bottom safe area. |
| Project sessions | Selection, sorting, target/status/prompt details and TDD controls were hidden. | Mobile has selection checkboxes, Select all, all six sort fields and sort direction. Bulk actions wrap. Session details exposes metadata, TDD and the conversation shortcut. |
| Session card readability | Action buttons compressed names and branch chips into unreadable fragments. The project path was clipped. | Names, branches and paths wrap. The extra conversation shortcut sits in Session details; row actions retain a separate menu. |
| Conversation tabs | Add/close targets were too small; inactive close buttons relied on hover. | Session and project conversation tabs have mobile touch sizing, visible close controls and less secondary chrome. |
| Settings | Save-bar content, field labels, nested workflow controls and model options could overflow narrow screens. | The footer wraps, retains safe-area clearance and keeps Save/Revert visible. Labels wrap; nested workflow fields stack; model option rows fit and wrap. |
| Pickers and document comments | Fixed-width model/profile/recipient popovers and comment cards could escape the viewport. Comment positioning assumed a desktop card width. | Popovers and cards are capped to the viewport. Comment positioning uses the measured card width; cards scroll vertically and have wrapping, touch-sized actions. |
| Charter | Version comparisons remained side by side, with small comparison/history controls. | Comparisons stack on mobile and controls have touch sizing. |
| Workflow builder | Mobile had no dependency editing and could not rename/remove an empty lane. | Each context offers Dependencies and Move to lane. Dependency changes use the existing validation/mutation paths, report refusals and restore focus. Empty lanes use the existing rename/merge/remove controls. Scroll clearance keeps graph controls off the last row. |
| Notepad | The mobile reading surface omitted the editor, history, review and organization controls. | Manage notepads opens the existing full notepad surface; Back to reading returns to the same note. Its toolbars wrap, menus/actions have touch sizing, and history rows fit phones. Existing autosave and revision handling are reused. |
| Agents and tickets | Some creation/filter controls lacked space or touch sizing. | Agent creation controls wrap; ticket filter controls have adequate mobile target height. |

## Verification

Final checks passed: TypeScript, lint, architecture seams, formatting and focused regression runs covering 31 distinct test files. Next.js reported no runtime or configuration errors. The session's browser, Next.js server and Storybook server were stopped after verification.

Behavior changes were reproduced with failing focused tests before implementation. Pure layout changes were checked in the browser. Regression coverage includes navigation/store transitions, session content and tabs, More focus behavior, Info copying, project sessions, settings, model controls, document comments, alignment, workflow dependencies/lanes, and notepad editing/history/revision handling.

Live verification used the worktree's isolated development database and a scratch project inside the worktree. It did not modify production conversations or projects.

| Surface | Checks |
| --- | --- |
| Conversation | Actual generated markdown/table/code content; 320px and 390px panels; all More destinations; 1440px desktop resize; panels after closing all tabs. Wide tables and code remain horizontally scrollable inside their own containers. |
| Compaction | Generated an actual conversation artifact from the phone UI; API reported `complete`; opened its source message and returned to Chat. |
| Memory | Created and opened an actual project note with long content at 320px. Library, note fields, actions and history remained reachable. |
| Project sessions | Selected/deselected rows, exposed bulk actions, changed sort, opened details; inspected mobile session-card stories. |
| Tickets | Populated board and long-title detail at 320px; fields, relationships, attachments and actions remained available. |
| Settings | Visited all eight sections at 320px, checked off-screen controls, made/reverted a local form edit and checked footer placement. |
| More | Screenshots at 320px, 390px and 768px. At 390×440, the final action remained reachable by scrolling. Keyboard dismissal restored focus; mobile controls hid at 1440px. |
| Workflow | Populated mobile builder story: add/remove dependency, cycle refusal, focus return and empty-lane naming. Desktop React Flow canvas still rendered at 1440px. |
| Charter and Specs | Populated charter/history/diff and Spec Studio questions/review stories at 320px; no off-screen action controls in those checks. |
| Notepad | Edited a real note at 320px; read back saved revision 2 from the API; returned to reading; opened revision history; pinned the note and verified persisted state. |

The generated conversation's illustrative audit prose was only a rendering fixture, not evidence for findings in this report. Storybook's absent API routes were fixture limitations; actual persistence was checked in the development app.

Screenshots and validation envelopes are under `.cc/temp/mobile-*` in this worktree. The report records a broad route and component audit, not a claim that every data permutation or physical device has been tested. Browser checks used Chromium viewport emulation; physical iOS Safari, the native on-screen keyboard and voice recording were not exercised. No production build or full repository test run was performed.
