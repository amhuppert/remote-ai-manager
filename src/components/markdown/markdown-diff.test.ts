import { describe, expect, it } from "vitest";

import {
  buildMarkdownDiffSource,
  DIFF_MARK_CLOSE,
  DIFF_MARK_OPEN,
} from "./markdown-diff";

function added(text: string): string {
  return `${DIFF_MARK_OPEN.added}${text}${DIFF_MARK_CLOSE.added}`;
}

function removed(text: string): string {
  return `${DIFF_MARK_OPEN.removed}${text}${DIFF_MARK_CLOSE.removed}`;
}

describe("buildMarkdownDiffSource", () => {
  it("leaves unchanged prose free of marks", () => {
    expect(
      buildMarkdownDiffSource(
        "Every execution pins **scope**.",
        "Every execution pins **scope**.",
      ),
    ).toBe("Every execution pins **scope**.");
  });

  it("marks the changed words of a revised line and nothing else", () => {
    expect(
      buildMarkdownDiffSource(
        "Every execution pins scope.",
        "Every execution records the exact selected scope.",
      ),
    ).toBe(
      `Every execution ${removed("pins ")}${added("records the exact selected ")}scope.`,
    );
  });

  it("marks one-sided elements whole", () => {
    expect(buildMarkdownDiffSource(null, "New **requirement**.")).toBe(
      added("New **requirement**."),
    );
    expect(buildMarkdownDiffSource("Retired requirement.", null)).toBe(
      removed("Retired requirement."),
    );
  });

  it("keeps Markdown block markers outside the marks", () => {
    expect(
      buildMarkdownDiffSource(
        "- Alpha keeps its scope",
        "- Alpha widens its scope",
      ),
    ).toBe(`- Alpha ${removed("keeps ")}${added("widens ")}its scope`);
    expect(
      buildMarkdownDiffSource("## Alpha contract", "## Omega contract"),
    ).toBe(`## ${removed("Alpha ")}${added("Omega ")}contract`);
    expect(
      buildMarkdownDiffSource("> Alpha contract", "> Omega contract"),
    ).toBe(`> ${removed("Alpha ")}${added("Omega ")}contract`);
    expect(
      buildMarkdownDiffSource(
        "1. Alpha\n2. Beta",
        "1. Alpha\n2. Beta\n3. Gamma",
      ),
    ).toBe(`1. Alpha\n2. Beta\n3. ${added("Gamma")}`);
  });

  it("replaces a wholly rewritten line with its own removed and added lines", () => {
    expect(buildMarkdownDiffSource("- Alpha\n- Beta", "- Alpha\n- Gamma")).toBe(
      `- Alpha\n- ${removed("Beta")}\n- ${added("Gamma")}`,
    );
  });

  it("keeps a dropped list item as its own struck-through bullet", () => {
    expect(buildMarkdownDiffSource("- Alpha\n- Beta", "- Alpha")).toBe(
      `- Alpha\n- ${removed("Beta")}`,
    );
  });

  it("splits unrelated lines instead of interleaving unreadable word runs", () => {
    expect(
      buildMarkdownDiffSource("Alpha beta gamma.", "Zeta eta theta."),
    ).toBe(`${removed("Alpha beta gamma.")}\n${added("Zeta eta theta.")}`);
  });

  it("treats an inline code span as one token so its backticks stay balanced", () => {
    expect(
      buildMarkdownDiffSource("Use `worker one` now.", "Use `worker two` now."),
    ).toBe(`Use ${removed("`worker one` ")}${added("`worker two` ")}now.`);
  });

  it("never marks structural lines that carry no words", () => {
    expect(
      buildMarkdownDiffSource(
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
        "| A | B |\n| --- | ---: |\n| 1 | 3 |",
      ),
    ).toBe(`| A | B |\n| --- | ---: |\n| 1 | ${removed("2 ")}${added("3 ")}|`);
  });

  it("shows the current revision of a fenced code block without marks", () => {
    expect(
      buildMarkdownDiffSource(
        "Run it:\n\n```ts\nconst a = 1;\n```",
        "Run it:\n\n```ts\nconst a = 2;\n```",
      ),
    ).toBe("Run it:\n\n```ts\nconst a = 2;\n```");
  });

  it("drops a fenced block that the current revision no longer carries", () => {
    expect(
      buildMarkdownDiffSource("Run it:\n\n```ts\nconst a = 1;\n```", "Run it:"),
    ).toBe("Run it:");
  });
});
