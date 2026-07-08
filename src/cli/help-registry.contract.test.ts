import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allHelpEntries,
  childEntriesOf,
  isGroup,
  renderHelpText,
  renderTopUsage,
} from "./help-registry";
import type { FlagSpec } from "./help-types";
import { pathKey } from "./help-types";

/**
 * The help-registry contract test (docs/design/cc-cli/04 §7.1) — the
 * drift-prevention backstop that replaces human vigilance over the
 * help/allowlist/skill sync (`.kiro/steering/cli.md`, "Single source of truth").
 * Every assertion here is the new "help is wrong" signal; each names the
 * offending entry and the invariant it broke so a failure is actionable without
 * reading this file.
 */

// Anchor on this test file's own location (src/cli/) rather than process.cwd(),
// so the on-disk skill-path check is correct regardless of the runner's cwd.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ENTRIES = allHelpEntries();
const KEYS = new Set(ENTRIES.map((entry) => pathKey(entry.path)));

/**
 * Every dispatchable command path that MUST have a registry entry — a
 * hard-coded mirror of `core.ts` dispatch plus each command's subcommand switch
 * (doc 04 §7.1 rule 1 / decision D14). The list IS the mirror: it is maintained
 * by hand and reviewed on change, so a future command added without a registry
 * entry fails this suite. Group nodes are included (doc 04 acceptance criterion
 * 1) — they must exist both as parents of their leaves and as `--help` hubs.
 */
const COVERAGE: string[] = [
  // top-level leaves
  "ask",
  "notify",
  "doctor",
  "version",
  // docs
  "docs",
  "docs register",
  "docs list",
  "docs delete",
  // dev
  "dev",
  "dev list",
  "dev ensure",
  "dev stop",
  // fixture
  "fixture",
  "fixture session",
  "fixture session create",
  "fixture session delete",
  "fixture prompt",
  "fixture status",
  // workflow — authoring/lifecycle
  "workflow",
  "workflow validate",
  "workflow create",
  "workflow replace",
  "workflow edit",
  "workflow list",
  "workflow get",
  "workflow status",
  "workflow start",
  "workflow delete",
  "workflow templates",
  // workflow — lane verbs
  "workflow task",
  "workflow task complete",
  "workflow task add",
  "workflow shared-doc",
  "workflow shared-doc upsert",
  "workflow collab",
  "workflow collab request",
  // workflow — live execution editing
  "workflow live",
  "workflow live get",
  "workflow live edit",
  "workflow live pause",
  "workflow live resume",
  // charter
  "charter",
  "charter write",
  // decisions
  "decisions",
  "decisions propose",
  // codex
  "codex",
  "codex run",
  "codex status",
  "codex cancel",
  // conversation
  "conversation",
  "conversation read",
  "conversation compact",
  "conversation compaction",
  "conversation compaction get",
  "conversation compaction list",
];

describe("help registry contract", () => {
  describe("every entry has non-empty summary/description/usage", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      it(`"${key}" has non-empty prose`, () => {
        expect(entry.summary.trim(), `${key}: empty summary`).not.toBe("");
        expect(entry.description.trim(), `${key}: empty description`).not.toBe(
          "",
        );
        expect(entry.usage.length, `${key}: no usage shapes`).toBeGreaterThan(
          0,
        );
        for (const shape of entry.usage) {
          expect(shape.trim(), `${key}: empty usage shape`).not.toBe("");
        }
      });
    }
  });

  describe("every leaf entry has >= 1 example", () => {
    for (const entry of ENTRIES) {
      if (isGroup(entry)) continue;
      const key = pathKey(entry.path);
      it(`leaf "${key}" teaches with an example`, () => {
        expect(
          entry.examples.length,
          `${key}: leaf node needs >= 1 example (doc 04 §7.1)`,
        ).toBeGreaterThan(0);
      });
    }
  });

  describe("every related.command resolves to a registry entry", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      for (const ref of entry.related) {
        it(`"${key}" -> related "${ref.command}" is not a dangling edge`, () => {
          expect(
            KEYS.has(ref.command),
            `${key}: related.command "${ref.command}" has no registry entry (dangling graph edge)`,
          ).toBe(true);
        });
      }
    }
  });

  describe("every skills[].path exists on disk", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      for (const skill of entry.skills ?? []) {
        it(`"${key}" -> skill "${skill.name}" path exists`, () => {
          const abs = path.resolve(REPO_ROOT, skill.path);
          expect(
            existsSync(abs),
            `${key}: skills path "${skill.path}" does not exist on disk (repo-relative)`,
          ).toBe(true);
        });
      }
    }
  });

  it("no single entry declares a flag name as both boolean and value", () => {
    // The parse-time boolean-flag set is COMMAND-SCOPED (parseArgv +
    // booleanFlagArgsForCommand, shared.ts / help-registry.ts): the authoritative
    // parse resolves the command path first, then uses THAT command's own boolean
    // flags. So a flag name may legitimately be `boolean` for one command and
    // `value` for another (e.g. `workflow get --config` boolean section selector
    // vs `workflow live get --config <ctx>` value, doc 06) — the cross-command
    // difference is intentional and sound because each command resolves to exactly
    // one entry (longest-prefix). What is NOT sound is a single entry declaring the
    // same flag name with two kinds, which would parse ambiguously for THAT
    // command; assert per-entry singularity.
    const conflicts: string[] = [];
    for (const entry of ENTRIES) {
      const kindsByFlag = new Map<string, Set<FlagSpec["kind"]>>();
      for (const flag of entry.flags) {
        const kinds = kindsByFlag.get(flag.name) ?? new Set();
        kinds.add(flag.kind);
        kindsByFlag.set(flag.name, kinds);
      }
      for (const [name, kinds] of kindsByFlag) {
        if (kinds.size > 1) {
          conflicts.push(
            `${pathKey(entry.path)}: --${name} declared as both boolean and value`,
          );
        }
      }
    }
    expect(conflicts, conflicts.join("; ")).toEqual([]);
  });

  it("resolves --config command-scoped: boolean for 'workflow get', value for 'workflow live get'", () => {
    // Pin the doc-06 collision the command-scoped parser exists to handle: the two
    // commands declare the same flag name with different kinds, and each command's
    // boolean set reflects its OWN declaration.
    const get = ENTRIES.find((e) => pathKey(e.path) === "workflow get");
    const liveGet = ENTRIES.find(
      (e) => pathKey(e.path) === "workflow live get",
    );
    expect(get?.flags.find((f) => f.name === "config")?.kind).toBe("boolean");
    expect(liveGet?.flags.find((f) => f.name === "config")?.kind).toBe("value");
  });

  it("declares --conversation on 'fixture prompt' (read with command-specific meaning)", () => {
    // fixture.ts:474 reads values["conversation"] as the explicit TARGET
    // fixture conversation id on the dev server — deliberately NOT the global
    // CC_CONVERSATION_ID fallback (which is the agent's own conversation on the
    // MANAGING server). Because the flag carries command-specific meaning here,
    // the "global flags are implied" convention does not cover it: the
    // registry-derived structured flag list must declare it, or the help/flag
    // source-of-truth is incomplete (2026-07-07 validation gap).
    const entry = ENTRIES.find((e) => pathKey(e.path) === "fixture prompt");
    expect(entry, "fixture prompt entry missing").toBeDefined();
    const conversation = entry?.flags.find((f) => f.name === "conversation");
    expect(
      conversation,
      "fixture prompt must declare the --conversation flag it reads (fixture.ts:474)",
    ).toBeDefined();
    expect(
      conversation?.kind,
      "fixture prompt --conversation takes a value",
    ).toBe("value");
  });

  describe("dispatchable command coverage", () => {
    for (const command of COVERAGE) {
      it(`"${command}" has a registry entry`, () => {
        expect(
          KEYS.has(command),
          `dispatchable command "${command}" has no registry entry (doc 04 §7.1 coverage list)`,
        ).toBe(true);
      });
    }
  });

  describe("top usage and group indexes list their commands (doc 04 §7.1 rule 6)", () => {
    const topUsage = renderTopUsage();

    for (const entry of ENTRIES) {
      if (entry.path.length !== 1) continue;
      const key = pathKey(entry.path);
      it(`level-1 "${key}" appears in the generated top usage`, () => {
        expect(
          topUsage.includes(key),
          `top usage omits level-1 command "${key}"`,
        ).toBe(true);
      });
    }

    for (const entry of ENTRIES) {
      if (!isGroup(entry)) continue;
      const key = pathKey(entry.path);
      const rendered = renderHelpText(entry);
      for (const child of childEntriesOf(entry.path)) {
        const childKey = pathKey(child.path);
        it(`group "${key}" index lists child "${childKey}"`, () => {
          expect(
            rendered.includes(childKey),
            `group "${key}" index omits child "${childKey}"`,
          ).toBe(true);
        });
      }
    }
  });
});
