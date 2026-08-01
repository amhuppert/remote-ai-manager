# Native SDD Issues

## UI

- Font size for main content text too small
- Expected topbar breadcrumb navigation does not exist
- Gate Policy & Execution shouldn't be bundled together under the same screen.
- No obvious way to get to Questions and Assumptions screen
- In general, the page structure and navigation are unclear. Available screens are often hidden. Content hierarchy is unclear.
- Start Execution button is available before tasks are planned
- The original UI was created without phases enforced, so agents could create design and tasks at the same time as requirements. Now we enforce a phased approach where requirements must be created first, then design, then tasks. But the phases are not clearly communicated in the UI.

The UI needs to be very clear about what phase we're in:
- Whether the spec was just initialized
- Whether requirements are proposed but not approved
- Whether we're in the design phase
- Whether the design is proposed but not approved
- Whether tasks have been planned
- Etc.

There should be a visual indicator at the top of screens that shows where we are in the overall workflow — not just naming the current phase, but contextually grounding it in what the previous phase was and what comes next after this phase is finished.

### Controls Screen

- Banners take full width, but content only takes center
- Approve definition & start button does not work

### Questions & Assumptions Screen

- 

### Review screen

- Review screen does not use available width
- When expanded, the requirement header/title duplicates the expanded content and is not useful because it is always truncated.
- Grouping of acceptance criteria underneath the top-level requirement is not clear, which makes it suprising when approving the requirement also approves all of the AC listed below it.
- There are separate buttons for approving requirements and AC but approving any AC approves the requirement and all other AC in the requirement group.
- Open questions & assumptions are not included in the revision sign off
- For revised requirements and AC, display a colorized diff so that it is easy to identify small changes.
- We don't need both a "Approve all requirements" and a "Approve all remaining" button; "Approve all remaining" is sufficient.
- "Approve all remaining" should be deactivated or replaced when there aren't any more requirements to approve.
- After signing off on a revision, a blank review screen is displayed instead of navigating back to the main spec page. It shows "Review mode unavailable".
- "Added decision", "Added requirement", etc. is redundant with the "Added" chip we display right next to it. The text prefixes the actual content with the same typography, making it difficult to tell where the real content begins.

### Main Spec screen

- Side panels: realistically sized items (requirements, decisions, questions and assumptions, tasks) are truncated with no way to view the entire text.
- Need a dedicated view to read side panel items easily; give them the whole screen, not just a side panel.
- Side panels with overflowing content cannot be scrolled, making it impossible to view items at the bottom.
