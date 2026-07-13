# Production multiline input inventory

Every editable production multiline control is classified below. Storybook demos, tests, and read-only renderers are intentionally excluded. The shared native adapter is [MultilineInput](../src/components/MultilineInput.tsx); rich prompts use the shared prompt editor boundary.

| Surface | Tier | Primary action | Project context | Escape behavior |
| --- | --- | --- | --- | --- |
| Conversation and project-page composers | Rich prompt | Send turn | Composer props | Existing composer/popup behavior |
| Conversation sidebar peek reply | Rich prompt | Send turn | Active conversation props | Close popover |
| Optimistic New Session instructions | Rich prompt | Create session | Modal `projectName` | Dialog close |
| Spawn proposal initial prompt | Rich prompt | Create proposed sessions | Spawn card project context | Card edit behavior |
| Workflow launch text parameter | Baseline | Launch workflow | Owning workflow page | Existing form behavior |
| Approval rejection feedback | Baseline | Submit rejection | Conversation workflow context | Cancel rejection editor |
| Collaboration question answers | Baseline | Submit answers | Conversation workflow context | Existing card behavior |
| Decision-approval rejection feedback | Baseline | Submit decision batch | Conversation context | Existing panel behavior |
| Ask-question note | Baseline | Submit answer selection | Conversation context | Existing panel behavior |
| Join-conflict recovery guidance | Baseline | Retry recovery | Workflow context | Existing card behavior |
| Merge-conflict guidance | Baseline | Fix approved conflicts | Session dialog props | Existing dialog behavior |
| Workflow context title/description/acceptance criteria | Baseline | Save changes | Execution context | Existing editor behavior |
| Workflow execution task instructions | Baseline | Existing task save/add action | Execution context | Existing panel behavior |
| Workflow-builder task instructions and parameter defaults | Baseline | Save workflow definition | Project builder context; global templates explicitly show voice unavailable because transcription requires a project worktree | Existing inspector behavior |
| Workflow builder focus-sheet markdown | Baseline | Save workflow definition | Project builder context; same explicit global-template limitation | Dialog close |
| Ticket description editor | Baseline | Save ticket description | Ticket project props | Cancel edit |
| Ticket creation description | Baseline | Create ticket | Selected project | Dialog close |
| Ticket attachment dialog description and markdown | Baseline | Add attachment | Ticket project props | Dialog close |
| Ticket attachment-index description and markdown | Baseline | Save attachment | Ticket project props | Existing entry behavior |
| Document comment card note | Baseline | Save note | Session document context | Card close/cancel |
| Document comment popover note | Baseline | Queue or send comment | Session document context | Cancel popover |

Adding an editable production multiline control requires updating this inventory and using [MultilineInput](../src/components/MultilineInput.tsx) or the rich prompt boundary. The architecture test rejects raw textareas outside the shared native adapter.
