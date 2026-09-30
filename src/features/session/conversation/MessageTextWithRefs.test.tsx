// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithQuery as render } from "@/test/component-mocks";
import { renderSkillReference } from "@/lib/commands/skill-reference";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import { MessageTextWithRefs } from "./MessageTextWithRefs";

const CONVERSATION_REF =
  '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
  'scope="session" session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
  'conversation-id="conv-1" conversation-name="Refactor" backend="claude" ' +
  'backend-ref="sess-abc" transcript-path="/t/transcript.jsonl" ' +
  'debug-log-path="" status="new" last-activity-at="2024-01-01T00:00:00Z" />';

const MESSAGE_REF =
  '<message-ref project-name="my-app" conversation-id="conv-9" ' +
  'message-index="4" role="assistant" compacted="false" />';

const TICKET_REF =
  '<ticket-ref project-name="command-center" ticket-number="12" ' +
  'identifier="command-center#12" title="Add durable ticket context" ' +
  'read-command="cctl ticket get command-center#12" />';

const NOTEPAD_REF = buildNotepadRefXml({
  notepadId: "np-vision",
  name: "Command Center Vision",
  scope: "project",
  projectName: "command-center",
});

function markdownRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-markdown-intent="message"]');
}

describe("MessageTextWithRefs", () => {
  it("renders ordinary Markdown through the message adapter", async () => {
    const { container } = render(
      <MessageTextWithRefs text="Ship **the migration** now." />,
    );

    await waitFor(() => expect(markdownRoot(container)).not.toBeNull());
    const strong = screen.getByText("the migration");
    expect(strong.tagName).toBe("STRONG");
    expect(strong.closest('[data-markdown-intent="message"]')).not.toBeNull();
  });

  it("keeps prose and an interactive conversation reference in one paragraph", async () => {
    const { container } = render(
      <MessageTextWithRefs
        text={`Review ${CONVERSATION_REF} before the next step.`}
      />,
    );

    const chip = await screen.findByRole("button", { name: /Refactor/ });
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    expect(
      container.querySelectorAll('[data-markdown-intent="message"]'),
    ).toHaveLength(1);
    expect(chip.closest("p")?.textContent).toContain("Review");
    expect(chip.closest("p")?.textContent).toContain("before the next step.");
    expect(container.textContent).not.toContain("<conversation-ref");
  });

  it("keeps multiple reference kinds in their source order and list item", async () => {
    const { container } = render(
      <MessageTextWithRefs
        text={`- Read ${MESSAGE_REF}, then ${TICKET_REF} today.`}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll("[data-message-reference]"),
      ).toHaveLength(2);
    });
    const refs = Array.from(
      container.querySelectorAll("[data-message-reference]"),
    );
    expect(
      refs.map((ref) => ref.getAttribute("data-message-reference")),
    ).toEqual(["message-ref", "ticket-ref"]);
    expect(refs[0]?.closest("li")).toBe(refs[1]?.closest("li"));
    expect(refs[0]?.closest("li")?.textContent).toContain("today.");
  });

  it("leaves references in code and malformed tags as visible text", async () => {
    const malformed = '<message-ref role="assistant" compacted="false" />';
    const { container } = render(
      <MessageTextWithRefs
        text={`Literal \`${CONVERSATION_REF}\`.\n\n\`\`\`text\n${TICKET_REF}\n\`\`\`\n\n${malformed}`}
      />,
    );

    await waitFor(() => expect(markdownRoot(container)).not.toBeNull());
    expect(container.querySelector("[data-message-reference]")).toBeNull();
    expect(container.textContent).toContain(CONVERSATION_REF);
    expect(container.textContent).toContain(TICKET_REF);
    expect(container.textContent).toContain(malformed);
  });

  it("parses Markdown after a reference at the start of a line", async () => {
    const { container } = render(
      <MessageTextWithRefs
        text={`${NOTEPAD_REF}\n- **Next** review subscriptions`}
      />,
    );

    expect(await screen.findByTestId("notepad-ref-chip")).toHaveTextContent(
      "Command Center Vision",
    );
    const item = await screen.findByText("Next");
    expect(item.tagName).toBe("STRONG");
    expect(item.closest("li")).not.toBeNull();
    expect(container.textContent).not.toContain("<notepad-ref");
  });

  it("keeps escaped, entity-encoded, commented, and link-label refs literal", async () => {
    const escaped = `\\${NOTEPAD_REF}`;
    const encoded = NOTEPAD_REF.replace("<", "&lt;").replace("/>", "/&gt;");
    const comment = `<!-- ${NOTEPAD_REF} -->`;
    const linkLabel = `[${NOTEPAD_REF}](https://example.com)`;
    const { container } = render(
      <MessageTextWithRefs
        text={[escaped, encoded, comment, linkLabel].join("\n\n")}
      />,
    );

    await waitFor(() => expect(markdownRoot(container)).not.toBeNull());
    expect(container.querySelector("[data-message-reference]")).toBeNull();
    expect(container.textContent).toContain(NOTEPAD_REF);
    expect(screen.getByRole("link")).toHaveTextContent("notepad-ref");
  });

  it("does not alter a line-start reference inside a multiline comment or code span", async () => {
    const { container } = render(
      <MessageTextWithRefs
        text={`<!--\n${NOTEPAD_REF}\n-->\n\n\`before\n${NOTEPAD_REF}\nafter\``}
      />,
    );

    await waitFor(() => expect(markdownRoot(container)).not.toBeNull());
    expect(container.querySelector("[data-message-reference]")).toBeNull();
    expect(container.textContent).not.toContain("\uE000");
    expect(container.textContent).toContain(NOTEPAD_REF);
  });

  it("renders a selected skill as an inline chip beside another reference", async () => {
    const skill = renderSkillReference(
      "agentic-engineering-principles:agent-feedback-tiers",
      "/skills/agent-feedback-tiers/SKILL.md",
    );
    const { container } = render(
      <MessageTextWithRefs
        text={`Use ${skill} with ${CONVERSATION_REF} for this review.`}
      />,
    );

    const skillChip = await screen.findByRole("note", {
      name: "Skill agentic-engineering-principles:agent-feedback-tiers",
    });
    const refChip = await screen.findByRole("button", { name: /Refactor/ });
    expect(
      container.querySelector(
        'a[href="/skills/agent-feedback-tiers/SKILL.md"]',
      ),
    ).toBeNull();
    expect(skillChip).toHaveAttribute("data-skill-reference");
    expect(skillChip.textContent).toContain("agent-feedback-tiers");
    expect(skillChip.closest("p")).toBe(refChip.closest("p"));
    expect(skillChip.closest("p")?.textContent).toContain("for this review.");
    expect(
      container.querySelectorAll('[data-markdown-intent="message"]'),
    ).toHaveLength(1);
  });

  it("keeps a normal Markdown link as a normal link", async () => {
    const { container } = render(
      <MessageTextWithRefs text="Read [the guide](https://example.com/guide)." />,
    );
    await waitFor(() => expect(markdownRoot(container)).not.toBeNull());
    expect(screen.getByRole("link", { name: "the guide" })).not.toHaveAttribute(
      "data-skill-reference",
    );
  });

  it("keeps a remote SKILL.md link interactive", async () => {
    render(
      <MessageTextWithRefs text="Read [$review](https://example.com/review/SKILL.md)." />,
    );

    expect(
      await screen.findByRole("link", { name: "$review" }),
    ).toHaveAttribute("href", "https://example.com/review/SKILL.md");
  });
});
