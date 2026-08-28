---
name: brainstorm
description: Brainstorm Command Center feature ideas from a seed — a new idea, a direction, or an existing feature to iterate on.
disable-model-invocation: true
---

# Feature Brainstorming

Alex provides a seed: a feature idea, a direction, or an existing feature to iterate on. The deliverable is a set of feature ideas worth building. The ideas end the turn — tickets, specs, and implementation happen only after Alex picks winners and asks.

## Ground before ideating

The value here is in ideas only Command Center could have. Before generating anything, ground in what CC actually is today:

- The project steering (`.kiro/steering/`) — read the documents relevant to the seed's domain
- The code owning the seed's domain, plus the adjacent features it could compose with (references, right panel, conversations, workflows, specs, tickets, notifications, dev servers, validation, ...)

Every idea names the real CC surfaces it touches. An idea that would fit any product equally well is still ungrounded — keep digging until it's tailor-made.

## The multiplier principle

The strongest CC feature is a **multiplier**: it raises the value of features that already exist, so the whole becomes greater than the sum of its parts. The best multipliers create a capability neither feature had alone — not "feature A plus feature B," but something new that only their combination makes possible.

For each idea, ask what it composes with. An idea that makes three existing features more valuable outranks a standalone feature of equal effort. Standalone ideas are welcome, but say so plainly and let them compete on that footing.

## Range

Span the full range, and label where each idea sits:

- **Established patterns** — the obvious, proven value adds from existing software, translated into CC's context. Low-hanging fruit belongs here, stated without apology.
- **CC-native inventions** — ideas tailor-made for Command Center that exist nowhere else, because no other product has this combination of parts. This end is the challenge: go beyond what's been done. If an idea could appear in a competitor's changelog, it belongs in the first bucket — invent past it.

## Output

For each idea: a name, what it does, which existing features it multiplies (or "standalone"), and why it's valuable in Alex's actual workflows. Rank by value-for-effort and flag the ideas you'd bet on.

Done when the set spans both ends of the range and every major adjacent CC feature has been weighed — used or consciously passed over — as a composition partner for the seed.
