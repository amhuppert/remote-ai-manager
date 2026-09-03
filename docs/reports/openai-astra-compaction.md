# OpenAI GPT-6 Astra compaction: known behavior, replication limits, and harness lessons

Last checked: 2026-09-03

## Summary

OpenAI has not published an Astra-specific compaction algorithm. Its documentation presents compaction as a Responses API capability supported by GPT-6 Astra and earlier models. The API can replace an oversized conversation with a smaller context containing an opaque, encrypted compaction item and, in some cases, selected original items. That compacted context carries forward important prior state and reasoning for later turns.

An external tool can use OpenAI's implementation through the Responses API or build a provider-independent approximation from visible messages, tool results, and explicit working memory. It cannot independently reproduce OpenAI's exact mechanism because the compaction algorithm is undisclosed and Astra's private reasoning is exposed only as encrypted state that an external tool can replay but not inspect.

The large ARC-AGI-3 improvement should not be attributed to compaction alone. The reported harness changes addressed two related memory failures: private reasoning was discarded after each game action, and a rolling context window eventually removed earlier actions. Preserving reasoning between actions and compacting accumulated state allowed the agent to retain discoveries, failed experiments, and plans across a long sequential task. That changes the evaluation from a repeatedly reset model into a stateful agent system.

## Confidence labels

This note distinguishes three kinds of claim:

- **Documented:** stated in official OpenAI documentation.
- **Reported:** described in the benchmark discussion or its linked explanation but not specified in the API contract.
- **Inferred:** a conclusion consistent with the documented behavior, but not confirmed by OpenAI.

## What OpenAI documents

### Compaction is a Responses API feature, not a disclosed Astra-specific invention

The GPT-6 Astra model guide lists compaction among existing Responses API capabilities that Astra supports. OpenAI does not describe a separate Astra-only compressor. The public API offers two ways to compact context:

1. **Server-side compaction:** configure `context_management` with a `compact_threshold` in a normal `/responses` request. When rendered context crosses the threshold, the server performs compaction, emits a compaction item, prunes earlier context, and continues inference.
2. **Standalone compaction:** explicitly call `POST /responses/compact` with the current context, then use the returned output as the canonical context for the next `/responses` request.

The documented flow is:

```text
messages + tool interactions + prior response items
                       |
              context reaches threshold
                       |
              OpenAI compaction pass
                       |
 encrypted compaction item + possibly retained items
                       |
       older context is pruned or replaced
                       |
          next model invocation continues
```

The server-side API can trigger this automatically:

```json
{
  "model": "gpt-6-astra",
  "context_management": [
    {
      "type": "compaction",
      "compact_threshold": 200000
    }
  ]
}
```

The threshold above illustrates the documented API shape; it is not a published value for the ARC-AGI-3 harness.

### The compacted representation is opaque

A compacted response contains an item shaped like:

```json
{
  "id": "cmp_...",
  "type": "compaction",
  "encrypted_content": "gAAAAA..."
}
```

OpenAI describes this as carrying forward key prior state and reasoning using fewer tokens. It is not intended to be human-readable. The standalone endpoint may also retain original items from the prior context, and its entire output should be passed to the next request without additional pruning.

The endpoint reports input, output, cached, and reasoning-token usage for the compaction pass. This supports the inference that compaction is a model-side semantic operation rather than ordinary byte compression, but OpenAI does not disclose the internal implementation.

### The Responses API can preserve private reasoning between turns

For stateless reasoning-model requests, the Responses API can return encrypted reasoning items. A caller can append all response output items to the next request, preserving reasoning state and assistant phase information without receiving readable chain of thought. Supported models can also use `reasoning.context: "all_turns"` to make available prior reasoning relevant to later turns.

This gives an external harness access to continuation behavior without giving it access to Astra's private reasoning itself:

```text
third-party harness -> OpenAI API
third-party harness <- encrypted reasoning and compaction items
third-party harness -> replay the opaque items on the next request
```

## What is not publicly known

OpenAI has not disclosed:

| Question | Publicly established answer |
|---|---|
| Is compaction performed by Astra, a separate model, or another component? | Not stated |
| Is the representation prose, structured state, model activations, or a hybrid? | Not stated |
| What prompt, loss function, or retention objective is used? | Not published |
| How are facts and reasoning selected or prioritized? | Not published |
| Is the compaction pass deterministic? | Not stated |
| What compression ratio or output budget is targeted? | Not guaranteed |
| How much information may be lost? | Not quantified |
| What threshold and configuration were used for ARC-AGI-3? | Not documented in the API references reviewed |
| Can a compaction item move between models or providers? | Not promised |
| Was a special ARC-specific compactor used? | No public evidence in the official API documentation reviewed |

OpenAI has elsewhere characterized the operation as loss-aware rather than lossless. Applications therefore should not treat a compaction item as an archive or assume every detail survives.

## Why the harness improved ARC-AGI-3 performance

ARC-AGI-3 is an interactive, sequential benchmark. An agent explores an environment, takes actions, observes the consequences, infers hidden rules, and revises a plan. Success depends not only on reasoning at one instant but also on accumulating useful state over many actions.

### Failure mode 1: reasoning was reset after each action

**Reported:** In the earlier comparison harness, each action ended the model invocation and discarded its private reasoning. A later invocation could see the action history and brief notes, but not the hypotheses, deductions, or plans that produced those actions.

This creates a repeated reconstruction tax:

```text
observe -> infer rules -> choose action -> discard reasoning
   ^                                      |
   +---------- reconstruct next turn -----+
```

The model must spend tokens rediscovering prior insights. Reconstruction can also produce a different interpretation, lose a constraint, repeat a failed experiment, or abandon a partially completed plan.

### Failure mode 2: rolling truncation removed old evidence

**Reported:** As a trajectory grew, the earlier harness dropped old actions from the context. This is worse than summarization because the deletion is based on age rather than future relevance. An early observation can remain decisive late in a task even when many newer events have occurred.

### What the Responses harness changed

The Responses harness could preserve encrypted reasoning items across actions and replace an oversized history with compacted state instead of blindly dropping its oldest portion. The effective loop becomes:

```text
observe -> infer -> act -> preserve or compact discoveries -> continue
```

This can improve benchmark performance through several mechanisms:

- **Rule retention:** inferred mechanics remain available after the action that revealed them.
- **Negative-result retention:** the agent avoids retrying actions already shown not to work.
- **Plan continuity:** multi-action strategies survive API call boundaries.
- **Causal continuity:** later actions retain some account of why earlier actions were chosen, not just what happened.
- **Reduced reconstruction cost:** fewer tokens are spent rebuilding the same world model.
- **Longer effective horizon:** relevant early evidence can influence decisions after the raw transcript would have overflowed.

The improvement therefore does not necessarily imply an equally large increase in single-turn abstract reasoning. It shows that the model performs much better when the harness stops imposing artificial amnesia.

### Evaluation caveat

The measured system is:

```text
model + prompt + reasoning settings + tools + state retention + compaction policy
```

Changing the state-retention and compaction policy changes the evaluated system. The Responses harness may be a fairer estimate of real OpenAI product behavior, while still being an invalid direct comparison against another model evaluated with a weaker memory policy. Both statements can be true.

To isolate model capability, models need equivalent observable state, retention rules, and token budgets. To compare deployed agents, each provider's production harness may be appropriate, but the result should be labeled as a system comparison rather than a model-only comparison.

## What a third-party tool can replicate

### Case 1: use OpenAI's compaction service from an external harness

An external agent framework can call `/responses/compact` or enable server-side compaction, retain the returned encrypted items, and replay them on later requests. The framework does not need to understand the encrypted data.

This reproduces the public OpenAI workflow, subject to model and API access. It does not reproduce the implementation independently; it delegates compaction and interpretation of the opaque state to OpenAI.

### Case 2: build a provider-independent approximation

A third-party harness can implement semantic compaction over information it can observe:

- user and assistant messages;
- environment observations;
- actions and tool results;
- explicit reasoning summaries;
- plans, constraints, and unresolved questions;
- pointers to durable artifacts stored outside the model context.

A practical context layout is:

```text
[stable instructions]
[structured durable state]
[references to external artifacts and evidence]
[recent verbatim interaction tail]
[current observation and next objective]
```

The durable state could be explicit and portable:

```json
{
  "objective": "reach the exit",
  "constraints": ["avoid red tiles"],
  "observations": ["the western key opens room 3"],
  "failed_actions": ["north from 4,7 resets the level"],
  "completed_actions": ["collected western key"],
  "current_plan": ["return to room 2", "open room 3"],
  "open_questions": ["whether keys persist after reset"],
  "artifact_refs": ["trajectory://run-42/actions.jsonl"]
}
```

This design is inspectable, testable, portable across providers, and often preferable when auditability matters.

### Case 3: independently clone OpenAI's exact mechanism

This is not currently possible from public information. A third-party implementation lacks:

- the undisclosed compaction algorithm and its configuration;
- readable access to Astra's private reasoning;
- the ability to interpret OpenAI's encrypted compaction representation outside the OpenAI service;
- the exact ARC harness settings needed for a bit-for-bit reproduction.

An external compactor can summarize visible state or explicit reasoning summaries, but it cannot recover hidden reasoning that was never exposed. It may reproduce much of the behavioral gain without matching OpenAI's result.

## Principles for general agent harnesses

### 1. Treat memory as part of the agent, not as transcript plumbing

Context management can dominate long-horizon performance. A strong model with a weak memory loop may perform worse than a weaker model whose harness preserves the right state.

Measure the complete agent system, and version the prompt, tools, state schema, compactor, thresholds, and model together.

### 2. Compact by relevance, not age

Rolling truncation assumes old information is least useful. Long tasks frequently violate that assumption. Preserve information according to its role in future decisions:

- stable goals and constraints;
- established facts and invariants;
- decisions and their rationale;
- failed approaches and evidence;
- unresolved blockers;
- the next executable step.

### 3. Preserve causes as well as actions

An action log says what happened. A useful working memory also records why it happened and what was learned. Without causal state, an agent must reconstruct its strategy from behavior and may draw a different conclusion on every turn.

### 4. Separate memory classes

Do not force one summary to serve every purpose. Maintain separate layers:

- **Instructions:** stable behavioral and task constraints.
- **Working state:** current hypotheses, plan, and open questions.
- **Evidence:** exact observations and tool outputs required for verification.
- **Event log:** append-only history outside the context window.
- **Recent tail:** verbatim interactions where local detail matters.
- **Artifacts:** large files addressed by stable handles rather than pasted repeatedly.

Compress working state aggressively, but keep decisive evidence and artifacts recoverable.

### 5. Compact before overflow and at semantic boundaries

Trigger compaction with enough spare context for the compactor and the next action. Token thresholds are useful, but semantic boundaries such as completing exploration, finishing a subtask, or changing phases often produce cleaner state than an arbitrary mid-action cutoff.

### 6. Make repeated compaction composable

Long agents may compact already compacted state. Repeated free-form summarization can amplify omissions and errors. Reduce this risk by:

- updating a stable schema rather than rewriting an unconstrained narrative;
- keeping IDs, numbers, constraints, and evidence references exact;
- distinguishing observations from hypotheses;
- retaining provenance for important claims;
- recording superseded beliefs rather than silently overwriting them;
- periodically rebuilding state from the durable event log when feasible.

### 7. Validate continuity after compaction

Compaction quality should be evaluated behaviorally. After compaction, test whether the agent can still recover:

- the objective and non-negotiable constraints;
- completed and prohibited actions;
- critical observations;
- the current plan and its rationale;
- unresolved questions;
- exact identifiers needed for tools.

A smaller context is not an improvement if it changes the task or causes repeated work.

### 8. Expose harness conditions in benchmarks

Benchmark reports should disclose:

- whether private reasoning persists between turns;
- whether the harness uses raw history, truncation, summaries, or opaque state;
- the context and output budgets;
- compaction thresholds and frequency;
- whether compaction consumes charged tokens or extra model calls;
- what original items are retained;
- whether every model receives the same memory policy.

Useful evaluations should report both task success and memory-system costs: total tokens, compaction calls, latency, repeated actions, and failures attributable to lost state.

## Recommended design for a transparent third-party compactor

A portable harness can capture the main principle without imitating OpenAI's opacity:

1. Store every interaction in an append-only event log outside the prompt.
2. Maintain typed working state with goals, facts, hypotheses, decisions, failures, plan, open questions, and artifact references.
3. Keep a bounded recent verbatim tail for local coherence.
4. Compact when either a token threshold or a task-phase boundary is reached.
5. Ask the compactor to update the existing state rather than generate an unrelated summary.
6. Validate required fields and exact identifiers deterministically.
7. Preserve evidence handles so the agent can retrieve raw details on demand.
8. Measure post-compaction task continuity against a full-context baseline.

This will not reproduce Astra's hidden reasoning representation, but it can reproduce the central systems insight: retain decision-relevant state across action boundaries and compress it deliberately instead of imposing blind amnesia.

## Sources

- [Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
- [Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [Conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state)
- [Responses API: create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Responses API: compact a response](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
