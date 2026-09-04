import { describe, expect, it } from "vitest";

import { MEMORY_ADVISORY_CONTRACT } from "./advisory-contract";

/**
 * The contract is the only memory text every agent on every backend receives
 * unconditionally, and it is word-capped (spec R5.4, D4) because it is paid for
 * on every conversation. These assertions pin the rules the cap is spent on, so
 * a rewrite that drops one fails here rather than in a live session that quietly
 * stops recalling.
 */
describe("MEMORY_ADVISORY_CONTRACT", () => {
  const text = MEMORY_ADVISORY_CONTRACT;
  const words = text.split(/\s+/u).filter((word) => word.length > 0);

  it("stays under 300 words", () => {
    expect(words.length).toBeLessThan(300);
  });

  it("states what arrives: the full block once, deltas after, and the four verbs", () => {
    expect(text).toContain("<memory-index>");
    expect(text).toContain("<memory-index-delta>");
    expect(text).toMatch(/first turn/iu);
    for (const verb of ["get", "recall", "create", "link"]) {
      expect(text).toContain(`cctl memory ${verb}`);
    }
  });

  it("frames memory as advisory and point-in-time, verified against the live artifact", () => {
    expect(text).toMatch(/advisory/iu);
    expect(text).toMatch(/point-in-time/iu);
    expect(text).toMatch(/verify[^.]*live artifact/iu);
  });

  it("states that hooks are omitted, so recall before concluding", () => {
    expect(text).toMatch(/omitt?ed/iu);
    expect(text).toMatch(/recall before you conclude/iu);
  });

  it("states hook authorship and when a body is worth opening", () => {
    expect(text).toMatch(/hook is the whole index entry/iu);
    expect(text).toMatch(/stands? alone/iu);
    expect(text).toMatch(/body[^.]*mechanism or the exact command/iu);
  });

  it("names the three index modes and what each is for", () => {
    expect(text).toMatch(/`auto` competes/iu);
    expect(text).toMatch(/`always` reserves a slot/iu);
    expect(text).toMatch(/bites regardless of the task/iu);
    expect(text).toMatch(/`search-only`[^.]*never compete/iu);
  });

  it("states the artifact-linking multiplier", () => {
    expect(text).toMatch(/ticket, spec, or workflow it is about/iu);
    expect(text).toMatch(/leads the index/iu);
  });

  it("states the statusNote rule and the capture bar", () => {
    expect(text).toMatch(/statusNote, never in the hook/iu);
    expect(text).toMatch(
      /fact a live artifact answers[^.]*ticket, merge, or spec status[^.]*not recorded/iu,
    );
    expect(text).toMatch(/durable, non-obvious/iu);
    expect(text).toMatch(/not derivable/iu);
    expect(text).toMatch(/session-scoped working state/iu);
  });

  it("carries no changing index content, only the standing rules", () => {
    expect(text.startsWith("<memory-contract>")).toBe(true);
    expect(text.endsWith("</memory-contract>")).toBe(true);
    expect(text).not.toMatch(/showing \d+ of \d+/u);
  });
});
