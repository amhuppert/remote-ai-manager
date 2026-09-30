## Conversation subscriptions and inbox

Automatic passive follows belong to the current ordinary conversation, including
project conversations. Recorded involvement establishes them: supplied notepad
context, linked tickets, spec authorship/review and launched work. A read or
search alone does not create a follow.

```
cctl subscription list
cctl subscription unfollow <subscription-id>
cctl inbox list
cctl inbox list --all --limit 20 --offset 20
cctl inbox get <delivery-id>
```

`subscription list` includes the reason, remembered opt-out and any source-read
problem. `unfollow` persists the opt-out so later involvement cannot silently
reactivate it. Existing delivery evidence remains available.

`inbox list` reconciles durable source changes and returns a bounded page.
Omission metadata names the next read. `get` returns one saved occurrence and its
source retrieval command. Neither read acknowledges delivery or starts a turn.
Use `--all` to include accepted history. An uncertain delivery needs inspection;
it is not automatically replayed. Runtime acceptance does not prove agent action.

Passive updates accompany the user's next message. Generated turns and feedback
do not consume unrelated pending updates. Repeated revisions may be summarized,
while separate decisions and run outcomes retain their identities.

Scope comes from the injected conversation environment. Explicit project,
session and conversation flags address a different target within the authorized
scope. Project conversations use their project route and never a placeholder
session. Workflow lanes retain their assigned context policy and cannot use this
subscription surface.

Active wakeups, mode changes, advisory inbox hints and full UI controls are later
deliverables; these commands expose the passive foundation.
