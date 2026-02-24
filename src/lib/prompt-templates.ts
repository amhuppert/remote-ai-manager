/**
 * Prompt template for Focus mode objective understanding.
 * The agent researches the codebase, asks clarifying questions via AskUserQuestion,
 * and writes an enriched focus.md once it has full understanding.
 */
export function getUnderstandObjectivePrompt(objective: string): string {
  return `You are starting a new coding session. Your task is to deeply understand the following objective before beginning any implementation.

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

**Step 4: Confirm Understanding and Write Focus Document**

Once you have no remaining clarifying questions and fully understand the objective:

1. Present a concise summary (2-4 sentences) of what the objective entails
2. Confirm that you understand the objective and are ready to proceed

3. Write the enriched \`memory-bank/focus.md\` file with the following structure:

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

**Important Guidelines:**

- Do NOT begin implementing or writing any code other than focus.md
- Do NOT make assumptions about ambiguous requirements — always ask for clarification
- Be thorough in identifying potential issues or unclear areas
- Your questions should be specific and actionable`;
}
