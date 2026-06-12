import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// DS/perf verification (Req 14.1, 14.2, 14.3, 14.6): the cockpit references
// design-system tokens for color, uses only the locked motion durations, and
// renders the transcript through a virtualized list (never eagerly).

const here = dirname(fileURLToPath(import.meta.url));

function readCss(rel: string): string {
  return readFileSync(resolve(here, rel), "utf8");
}

const cockpitCss = readCss("styles/cockpit.css");
const composerCss = readCss("../composer/styles/composer.css");
const projectDetailCss = readCss("../styles/project-detail.css");
const allCss = `${cockpitCss}\n${composerCss}`;

describe("cockpit design-system compliance", () => {
  it("uses no hard-coded hex color values (tokens only)", () => {
    const hex = allCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });

  it("uses no rgb/rgba color literals except the established black drop-shadow", () => {
    const colorFns = allCss.match(/rgba?\([^)]*\)/g) ?? [];
    const disallowed = colorFns.filter((c) => !/^rgba\(0, ?0, ?0,/.test(c));
    expect(disallowed).toEqual([]);
  });

  it("references design-system accent tokens for semantic color", () => {
    expect(cockpitCss).toContain("var(--cyan)"); // active tab edge
    expect(cockpitCss).toContain("var(--amber)"); // unread dot / filter chips
    expect(composerCss).toContain("var(--violet"); // Codex / command identity
  });

  it("uses only the locked motion durations and no spring/bounce/scale", () => {
    const durations = allCss.match(/\b0?\.\d+s\b/g) ?? [];
    for (const d of durations) {
      expect(["0.15s", ".15s", "0.2s", ".2s"]).toContain(d);
    }
    expect(allCss).not.toMatch(/cubic-bezier|spring|scale\(/);
  });

  it("gates the entry animation behind prefers-reduced-motion", () => {
    expect(cockpitCss).toContain("prefers-reduced-motion");
  });

  it("keeps the cockpit visible once its entry animation ends", () => {
    // The cockpit mounts as a `.stagger-in > *` child, which sets a resting
    // `opacity: 0` (globals.css). The `.plc-enter` entry animation must
    // therefore *settle* on opacity 1 — via `forwards` when it runs, and via an
    // explicit opacity when reduced motion disables it — or the whole cockpit
    // reverts to that inherited `opacity: 0` and renders invisible.
    const baseEnter = cockpitCss.match(/\.plc-enter\s*\{([^}]*)\}/);
    expect(baseEnter?.[1]).toMatch(/animation:[^;]*\bforwards\b/);

    const reducedEnter = cockpitCss.match(
      /prefers-reduced-motion[^{]*\{[\s\S]*?\.plc-enter\s*\{([^}]*)\}/,
    );
    expect(reducedEnter?.[1]).toMatch(/opacity:\s*1/);
  });

  it("uses a primary view switch above the active cockpit panel", () => {
    const cockpit = cockpitCss.match(/\.plc-cockpit\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(cockpit).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
    const areas =
      cockpit.match(/grid-template-areas:\s*([\s\S]*?);/)?.[1] ?? "";
    expect(areas).toContain("view view");
    expect(areas).toContain("rail conversation");

    const sessionsLayout =
      cockpitCss.match(
        /\.plc-cockpit\[data-workspace-view="sessions"\]\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(sessionsLayout).toContain('"view"');
    expect(sessionsLayout).toContain('"sessions"');
  });

  it("shows only the selected project workspace panel", () => {
    expect(cockpitCss).toContain(
      '.plc-cockpit[data-workspace-view="sessions"] .plc-workspace-pane',
    );
    expect(cockpitCss).toContain(
      '.plc-cockpit[data-workspace-view="conversations"] .plc-sessions',
    );
  });

  it("places the conversation rail beside the transcript workspace", () => {
    const cockpit = cockpitCss.match(/\.plc-cockpit\s*\{([^}]*)\}/)?.[1] ?? "";
    const areas =
      cockpit.match(/grid-template-areas:\s*([\s\S]*?);/)?.[1] ?? "";
    const railColumn = areas.indexOf("rail");
    const convoRow = areas.indexOf("conversation");
    expect(railColumn).toBeGreaterThanOrEqual(0);
    expect(convoRow).toBeGreaterThanOrEqual(0);
    expect(convoRow).toBeGreaterThan(railColumn);
  });

  it("removes the inter-pane gaps (flush panes)", () => {
    const cockpit = cockpitCss.match(/\.plc-cockpit\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(cockpit).not.toMatch(/gap:\s*var\(--space/);
  });

  it("uses no rounded borders on the rail, conversation, or sessions panes", () => {
    for (const sel of ["\\.plc-rail", "\\.plc-pane", "\\.plc-sessions"]) {
      const rule =
        cockpitCss.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule).not.toMatch(/border-radius/);
    }
  });

  it("fills the remaining project-page viewport height through the cockpit columns", () => {
    expect(projectDetailCss).toMatch(
      /\.app\[data-page="sessions"\]\[data-page-variant="project-detail"\]\s+\.main\s*\{[^}]*display:\s*flex/s,
    );
    expect(projectDetailCss).toMatch(
      /\.project-detail-shell\s*\{[^}]*flex:\s*1/s,
    );
    expect(projectDetailCss).toMatch(
      /\.project-detail-shell\s*\{[^}]*min-height:\s*0/s,
    );
    expect(cockpitCss).toMatch(/\.plc-cockpit\s*\{[^}]*flex:\s*1/s);
    expect(cockpitCss).toMatch(/\.plc-rail\s*\{[^}]*height:\s*100%/s);
    expect(cockpitCss).toMatch(/\.plc-workspace-pane\s*\{[^}]*height:\s*100%/s);
    expect(cockpitCss).toMatch(/\.plc-pane\s*\{[^}]*height:\s*100%/s);
    expect(cockpitCss).toMatch(/\.plc-sessions\s*\{[^}]*height:\s*100%/s);
  });

  it("constrains the embedded active-conversations rail so its list can scroll", () => {
    const rail = cockpitCss.match(/\.plc-rail\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rail).toMatch(/display:\s*flex/);
    expect(rail).toMatch(/flex-direction:\s*column/);

    const toggleRow =
      cockpitCss.match(/\.plc-rail-toggle-row\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(toggleRow).toMatch(/flex-shrink:\s*0/);

    const embeddedSidebar =
      cockpitCss.match(/\.plc-rail\s*>\s*\.convo-sidebar\s*\{([^}]*)\}/)?.[1] ??
      "";
    expect(embeddedSidebar).toMatch(/flex:\s*1/);
    expect(embeddedSidebar).toMatch(/min-height:\s*0/);
    expect(embeddedSidebar).toMatch(/height:\s*auto/);
  });
});
