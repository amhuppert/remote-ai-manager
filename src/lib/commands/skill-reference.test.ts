import { describe, expect, it } from "vitest";
import {
  findSkillReferences,
  parseSkillReferences,
  renderSkillReference,
} from "./skill-reference";

describe("explicit skill references", () => {
  it("retains the exact skill path through URI encoding", () => {
    const path = "/Users/Alex/skills [local](draft)/a%#?<>雪/SKILL.md";
    const reference = renderSkillReference("plugin:wait-what", path);

    expect(reference).toBe(
      "[$plugin:wait-what](</Users/Alex/skills%20%5Blocal%5D%28draft%29/a%25%23%3F%3C%3E%E9%9B%AA/SKILL.md>)",
    );
    expect(
      parseSkillReferences(`Use ${reference} with these arguments`),
    ).toEqual([{ name: "plugin:wait-what", path }]);
  });

  it("finds multiple selections and retains their offsets for editor restoration", () => {
    const first = "[$same](</first/SKILL.md>)";
    const second = "[$same](</second/SKILL.md>)";
    const text = `${first} then ${second}`;

    expect(findSkillReferences(text)).toEqual([
      { name: "same", path: "/first/SKILL.md", start: 0, end: first.length },
      {
        name: "same",
        path: "/second/SKILL.md",
        start: first.length + 6,
        end: text.length,
      },
    ]);
  });

  it("does not invoke quoted code, escaped links, images, or ordinary mentions", () => {
    const reference = "[$wave](</skills/wave/SKILL.md>)";
    expect(
      parseSkillReferences(
        [
          `$wave [wave](</skills/wave/SKILL.md>)`,
          `\`${reference}\``,
          `\`\`code \` ${reference}\`\``,
          "```markdown",
          reference,
          "```",
          "  ~~~~",
          reference,
          "  ~~~~",
          `\\${reference}`,
          `!${reference}`,
          `Actual selection: ${reference}`,
        ].join("\n"),
      ),
    ).toEqual([{ name: "wave", path: "/skills/wave/SKILL.md" }]);
  });

  it("ignores malformed percent escapes without losing other selections", () => {
    expect(
      parseSkillReferences(
        "[$broken](</path/%broken>) [$ok](</skills/ok/SKILL.md>)",
      ),
    ).toEqual([{ name: "ok", path: "/skills/ok/SKILL.md" }]);
  });
});
