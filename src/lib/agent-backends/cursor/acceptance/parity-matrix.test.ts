// @vitest-inputs src/**/*.test.{ts,tsx,mjs} docs/reports/*cursor*.md docs/plans/command-center-112-queue-forks/*.md docs/cursor-backend.md
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_AUDIT_BASELINE_GAPS,
  CURSOR_PARITY_AREAS,
  CURSOR_PARITY_MATRIX,
  CURSOR_PARITY_OWNERS,
  describeCursorDescriptorFacts,
  renderCursorCapabilityDisclosure,
  renderCursorParityMatrix,
} from "./parity-matrix";

/**
 * What makes the parity matrix executable (ticket command-center#125).
 *
 * The matrix exists because "Cursor reaches parity" is a claim that decays
 * silently: a capability flag flips, a cited test is deleted, a support
 * document keeps advertising a restriction that was lifted, and every prose
 * record of the verification still reads as true. Each assertion below is one
 * way that decay is caught — against the registered descriptor, against the
 * repository, and against the two documents that publish the result.
 */

const REPO_ROOT = process.cwd();
const FINAL_REPORT =
  "docs/reports/2026-09-21-cursor-parity-final-validation.md";
const SUPPORT_DOC = "docs/cursor-backend.md";
const ACCEPTANCE_DIR = "src/lib/agent-backends/cursor/acceptance";

const MATRIX_BEGIN = "<!-- cursor-parity-matrix:begin -->";
const MATRIX_END = "<!-- cursor-parity-matrix:end -->";
const DISCLOSURE_BEGIN = "<!-- cursor-capability-disclosure:begin -->";
const DISCLOSURE_END = "<!-- cursor-capability-disclosure:end -->";

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** The section a renderer owns, so a hand edit inside the fences is a failure
 *  rather than a silent divergence from the descriptor. */
function fencedSection(
  document: string,
  begin: string,
  end: string,
  label: string,
): string {
  const start = document.indexOf(begin);
  const stop = document.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error(`${label} does not carry the ${begin} … ${end} fences`);
  }
  return document.slice(start + begin.length, stop).trim();
}

const facts = describeCursorDescriptorFacts();

/**
 * The shapes of `caseId` one acceptance file can publish.
 *
 * Read per file rather than pooled across the suite, so a row citing a real
 * case id against the wrong file sends no reader to evidence that file never
 * produces. Some ids are template literals built from the case's parameters
 * (`native-memory-${kind}-fallback`), so an interpolation becomes a wildcard
 * and the literal text around it still has to match. The live run's own check
 * on the published records is the exact one; this is the static half that
 * catches a rename without spending a credential.
 */
function caseIdShapesPublishedBy(file: string): readonly RegExp[] {
  if (!existsSync(path.join(REPO_ROOT, file))) return [];
  const source = read(file);
  const shapes: RegExp[] = [];
  for (const match of source.matchAll(/caseId: (?:"([^"]+)"|`([^`]+)`)/g)) {
    const literal = match[1];
    if (literal !== undefined) {
      shapes.push(new RegExp(`^${escapeRegExp(literal)}$`));
      continue;
    }
    const template = match[2];
    if (template === undefined) continue;
    const pattern = template
      .split(/\$\{[^}]*\}/)
      .map((part) => escapeRegExp(part))
      .join("[^\\s]+");
    shapes.push(new RegExp(`^${pattern}$`));
  }
  return shapes;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the matrix is a complete enumeration", () => {
  it("gives every row a unique id and a declared area", () => {
    const ids = CURSOR_PARITY_MATRIX.map((row) => row.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids.length).toBeGreaterThan(0);
    for (const row of CURSOR_PARITY_MATRIX) {
      expect(row.id, `${row.id} is not a stable slug`).toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
      );
      expect(
        CURSOR_PARITY_AREAS,
        `${row.id} declares an unknown area`,
      ).toContain(row.area);
    }
  });

  it("covers every area the ticket requires a live flow for", () => {
    const covered = new Set(CURSOR_PARITY_MATRIX.map((row) => row.area));
    expect(
      [...CURSOR_PARITY_AREAS].filter((area) => !covered.has(area)),
    ).toEqual([]);
  });

  it("attributes every row to a ticket, and gives every child ticket a row", () => {
    const owners = new Set(CURSOR_PARITY_MATRIX.map((row) => row.owner));
    for (const row of CURSOR_PARITY_MATRIX) {
      expect(
        CURSOR_PARITY_OWNERS,
        `${row.id} names an owner outside the delivery group`,
      ).toContain(row.owner);
    }
    // Every dependency of #125 delivered an outcome, so every dependency has to
    // appear in the final enumeration — including the ones whose outcome was a
    // disclosed limitation rather than a capability.
    expect(
      [...CURSOR_PARITY_OWNERS].filter((owner) => !owners.has(owner)),
    ).toEqual([]);
  });

  it("closes every gap the 2026-09-04 audit recorded, exactly once each", () => {
    const claimed = CURSOR_PARITY_MATRIX.flatMap((row) => row.auditGaps);
    for (const gap of claimed) {
      expect(
        Object.keys(CURSOR_AUDIT_BASELINE_GAPS),
        `an unknown audit gap "${gap}" is claimed`,
      ).toContain(gap);
    }
    expect(
      Object.keys(CURSOR_AUDIT_BASELINE_GAPS).filter(
        (gap) => !claimed.includes(gap),
      ),
      "an audit gap reaches the final matrix unclaimed",
    ).toEqual([]);
    expect(
      claimed.filter((gap, index) => claimed.indexOf(gap) !== index),
      "two rows claim the same audit gap, so neither owns it",
    ).toEqual([]);
  });
});

describe("the matrix cannot outlive the descriptor it describes", () => {
  it("names only capability facts the registered descriptor publishes", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      for (const fact of row.facts) {
        expect(
          Object.keys(facts),
          `${row.id} rests on "${fact}", which the descriptor no longer publishes`,
        ).toContain(fact);
      }
    }
  });

  it("leaves no published capability fact unclaimed by a row", () => {
    const claimed = new Set(CURSOR_PARITY_MATRIX.flatMap((row) => row.facts));
    expect(
      Object.keys(facts).filter((fact) => !claimed.has(fact)),
      "the descriptor grew a capability the matrix does not account for",
    ).toEqual([]);
  });

  it("never calls an instruction-only or absent mechanism enforced", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      if (row.mechanism === "native" || row.mechanism === "cc-owned") continue;
      expect(
        row.limitation,
        `${row.id} is ${row.mechanism} but discloses no limitation`,
      ).not.toBeNull();
    }
  });
});

describe("every row carries evidence or an explicit blocker", () => {
  it("resolves every cited test file", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      for (const entry of row.evidence) {
        if (entry.kind !== "test") continue;
        expect(entry.file, `${row.id} cites a non-test file`).toMatch(
          /\.test\.tsx?$/,
        );
        expect(
          existsSync(path.join(REPO_ROOT, entry.file)),
          `${row.id} cites ${entry.file}, which no longer exists`,
        ).toBe(true);
      }
    }
  });

  it("resolves every cited live acceptance case to the file that publishes it", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      for (const entry of row.evidence) {
        if (entry.kind !== "acceptance-case") continue;
        expect(
          entry.file.startsWith(ACCEPTANCE_DIR),
          `${row.id} cites a live case outside the acceptance suite`,
        ).toBe(true);
        const shapes = caseIdShapesPublishedBy(entry.file);
        expect(
          shapes.some((shape) => shape.test(entry.caseId)),
          `${row.id} cites live case "${entry.caseId}", which ${entry.file} does not publish`,
        ).toBe(true);
      }
    }
  });

  it("resolves every cited report", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      for (const entry of row.evidence) {
        if (entry.kind !== "report") continue;
        expect(
          existsSync(path.join(REPO_ROOT, entry.file)),
          `${row.id} cites ${entry.file}, which no longer exists`,
        ).toBe(true);
      }
    }
  });

  it("lets a row pass only on evidence, and fail only with a named blocker", () => {
    for (const row of CURSOR_PARITY_MATRIX) {
      if (row.verdict === "verified") {
        expect(
          row.evidence.length,
          `${row.id} is verified on no evidence at all`,
        ).toBeGreaterThan(0);
        expect(
          row.blocker,
          `${row.id} is verified but names a blocker`,
        ).toBeNull();
        continue;
      }
      expect(
        row.blocker,
        `${row.id} is unresolved without naming what blocks it`,
      ).toBeTruthy();
    }
  });

  it("proves a verified live flow with something durable, not only a unit test", () => {
    // A green unit test says the code branches correctly. It does not say an
    // authenticated turn produced the row's behavior, which is the whole point
    // of this ticket — so every row that claims a live flow has to cite a live
    // acceptance case or the report that records the authenticated run.
    for (const row of CURSOR_PARITY_MATRIX) {
      if (!row.liveFlow || row.verdict !== "verified") continue;
      expect(
        row.evidence.some((entry) => entry.kind !== "test"),
        `${row.id} claims a live flow but cites only unit tests`,
      ).toBe(true);
    }
  });
});

describe("the published documents agree with the descriptor", () => {
  it("carries the rendered matrix in the final validation report", () => {
    expect(
      fencedSection(read(FINAL_REPORT), MATRIX_BEGIN, MATRIX_END, FINAL_REPORT),
    ).toBe(renderCursorParityMatrix(CURSOR_PARITY_MATRIX).trim());
  });

  it("carries the rendered capability disclosure in the support document", () => {
    expect(
      fencedSection(
        read(SUPPORT_DOC),
        DISCLOSURE_BEGIN,
        DISCLOSURE_END,
        SUPPORT_DOC,
      ),
    ).toBe(renderCursorCapabilityDisclosure().trim());
  });

  it("states every limitation and blocker in the report a reader will open", () => {
    const report = read(FINAL_REPORT);
    for (const row of CURSOR_PARITY_MATRIX) {
      const disclosure = row.blocker ?? row.limitation;
      if (disclosure === null) continue;
      expect(
        report.includes(disclosure),
        `${row.id} discloses a limitation the report does not print`,
      ).toBe(true);
    }
  });

  it("keeps the support document free of retired Phase 1 refusals", () => {
    // The support document is what a user reads before choosing a backend. It
    // spent Phase 1 listing capabilities as unsupported that the delivery group
    // has since shipped, and a stale refusal there is a worse failure than a
    // missing one: it turns a working feature off in the reader's head.
    const supported = CURSOR_PARITY_MATRIX.filter(
      (row) => row.verdict === "verified" && row.mechanism !== "unavailable",
    );
    expect(supported.length).toBeGreaterThan(0);
    const doc = read(SUPPORT_DOC);
    expect(doc).not.toMatch(/^##\s+Unsupported in Phase 1\s*$/m);
    expect(doc).toContain(FINAL_REPORT.replace("docs/", ""));
  });
});
