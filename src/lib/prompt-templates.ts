/**
 * Prompt template for Focus mode objective understanding (Steps 1–3).
 * The agent researches the codebase and asks clarifying questions via AskUserQuestion.
 * Does NOT write focus.md — that happens in a separate step after user confirmation.
 */
export function getUnderstandObjectivePrompt(objective: string): string {
  return `<command-name>focus:understand-objective</command-name>
<command-args>${objective}</command-args>
You are starting a new coding session. Your task is to deeply understand the following objective before beginning any implementation.

<objective>
${objective}
</objective>

## Instructions

**Step 1: Research and Analysis**

Conduct thorough research to understand the objective:

- Explore the project structure, read relevant files, and understand existing patterns and conventions
- If the objective references specific technologies, libraries, APIs, or frameworks you're unfamiliar with, perform web research to understand how they work, their documentation, common usage patterns, and best practices
- Identify what parts of the codebase are relevant to this objective
- Gather all necessary context including: existing implementations, related functionality, dependencies, configuration files, documentation, and any constraints or requirements
- Identify any ambiguities, unclear requirements, missing information, open design decisions, or conflicting requirements in the objective

**Step 2: Ask Clarifying Questions**

If your analysis reveals any unclear areas, missing details, open design decisions, or conflicting requirements, you MUST ask clarifying questions using the AskUserQuestion tool.

Before asking questions, think through:
- Everything you understand about the objective
- Specific ambiguities, gaps, or unclear areas you've identified
- Clear, specific questions that will resolve these issues

Ask 1-4 questions per tool call. Each question requires a header (max 12 chars), question text, multiSelect boolean, and 2-4 options with labels and descriptions.

**Step 3: Incorporate Responses and Iterate**

After receiving answers:
- Incorporate the user's selections and any custom input into your understanding
- If the answers reveal new areas that need research or raise additional questions, perform additional analysis and ask follow-up questions
- Repeat this cycle until you have complete clarity on the objective

**Step 4: Present Your Understanding**

Once you have no remaining clarifying questions and fully understand the objective:

1. Present a concise summary (2-4 sentences) of what the objective entails
2. List the key requirements and design decisions you've identified
3. Describe your high-level implementation approach

The user will review your understanding and confirm when they are satisfied. Do NOT write focus.md yet — that will be handled separately after confirmation.

**Important Guidelines:**

- Do NOT begin implementing or writing any code
- Do NOT write focus.md — wait for the user to confirm your understanding first
- Do NOT make assumptions about ambiguous requirements — always ask for clarification
- Be thorough in identifying potential issues or unclear areas
- Your questions should be specific and actionable`;
}

/**
 * Prompt template for writing the focus document (Step 4).
 * Sent after the user confirms the agent has sufficient understanding.
 */
export function getWriteFocusDocumentPrompt(): string {
  return `<command-name>focus:write-document</command-name>
Based on everything we've discussed — the research, your questions, and my answers — write the enriched \`memory-bank/focus.md\` file now.

Use the following structure:

\`\`\`markdown
# Session Focus

## Objective

[The original objective]

## Detailed Requirements

[Detailed requirements derived from your research and Q&A]

## Key Design Decisions

[Design decisions and rationale from the clarification process]

## Implementation Approach

[High-level approach based on your codebase analysis]

## Relevant Patterns

[Existing patterns discovered in the codebase that should be followed]
\`\`\`

Write the file and nothing else. Do NOT begin any implementation work.`;
}
