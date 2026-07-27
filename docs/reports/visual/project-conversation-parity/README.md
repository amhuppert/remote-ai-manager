# R4.2 — project cockpit renders the shared Ask Question panel

Screenshot evidence for `project-conversation-parity/R4.2`: the project cockpit
mounts the shared `AskQuestionPanel` for the active conversation, hydrated from
that conversation's durable `pendingQuestionId` / `pendingQuestions` fields.

Both captures come from the `PendingQuestion` story in
`src/features/project-detail/cockpit/ProjectCockpit.stories.tsx`, whose
conversation fixture carries only the persisted fields — no live ask-question
event is dispatched, which is what makes the panel's presence a hydration proof
rather than an event-handling one.

| File | State |
| --- | --- |
| `r4-2-ask-panel-in-composer-slot.png` | Minimized — the panel occupies the composer's slot while the tab reads `Waiting for input`. |
| `r4-2-ask-panel-expanded.png` | Docked — the two-question batch with its rail, suggested option, and trade-offs. |

Regenerate:

```bash
cctl dev ensure storybook   # or: node_modules/.bin/storybook dev --port <port>
playwright-cli open --browser=chrome
playwright-cli resize 1440 664
playwright-cli goto "http://localhost:<port>/iframe.html?id=project-cockpit-projectcockpit--pending-question&viewMode=story"
playwright-cli click "getByRole('tab', { name: /Conversations/ })"
playwright-cli screenshot --filename=r4-2-ask-panel-expanded.png
playwright-cli press Escape
playwright-cli screenshot --filename=r4-2-ask-panel-in-composer-slot.png
```
