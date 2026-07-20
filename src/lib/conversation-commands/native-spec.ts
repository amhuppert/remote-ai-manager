const NATIVE_SPEC_AUTHORING_INSTRUCTIONS = `
<native-spec-authoring>
Author a native Command Center spec for the request below in this conversation.
Conversations author; Spec Studio reviews, approves, and browses.
Do not write or update \`.kiro/specs/\`, and do not treat a conversation
document as the authoritative spec object.

Read \`cctl spec --help\` and the relevant leaf help before composing payloads.
Use \`cctl spec list\` and \`cctl spec search\` to avoid creating a competing
object. No durable spec exists until the first successful draft save: when the
first element is ready, run \`cctl spec create --slug <slug> --name <name>
--preset <preset> --file <first-element.json>\` — one atomic call that creates
the spec, its draft revision, and the first element together, visible
immediately through \`cctl spec list\` and Spec Studio. Do not create the spec
before the first element is ready. Partial drafts are valid; continue with
element-granular, base-versioned \`cctl spec draft\` writes. If create refuses
with \`slug_taken\`, follow the returned instruction: continue the existing
draft or choose a different slug.

Use \`cctl ask\` only when missing intent would materially change the spec.
Question batches stay small, skippable, visible, and prunable. The server never
blocks on elicitation. Open questions that belong to the spec itself are
recorded durably with \`cctl spec question\` — they become addressable (Q1,
Q2, …) and reviewable in Spec Studio; record meaningful assumptions through
\`cctl spec assume\` when proceeding without an answer. Never approve, sign
off, dispose assumptions, change gate policy, or record proof verdicts on the
user's behalf.
</native-spec-authoring>
`.trim();

export function expandNativeSpecCommandForAgent(prompt: string): string {
  const trimmed = prompt.trimStart();
  const match = /^\/spec(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return prompt;

  const request = (match[1] ?? "").trim();
  if (request.length === 0) return NATIVE_SPEC_AUTHORING_INSTRUCTIONS;

  return `${NATIVE_SPEC_AUTHORING_INSTRUCTIONS}\n\n<spec-request>\n${request}\n</spec-request>`;
}
