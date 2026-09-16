# Spec-driven testing (plan → generate → heal)

End-to-end workflow for authoring and maintaining Playwright tests using `playwright-cli`. The three sections below can be used independently:

- **Planning** — explore the app, produce a spec file describing what to test.
- **Generate** — turn a spec into Playwright test files. Update the spec if it's vague or stale.
- **Heal** — diagnose failing tests, fix the code, reconcile the spec with reality.

For interactive diagnosis that the registered runner cannot express, and after stating that narrow reason, these phases can use this version-dependent mechanic: run `npx playwright test --debug=cli` in the background, then `playwright-cli attach tw-XXXX` to drive the paused page interactively. See [playwright-tests.md](playwright-tests.md) for the debug/attach mechanics and [test-generation.md](test-generation.md) for how every `playwright-cli` action emits Playwright TypeScript.

---

These are supporting test plans, not a replacement for Command Center native specs or their human approvals. Keep expected behavior grounded in the user request and governing spec; observation alone does not establish intended behavior.

## 1. Planning

Goal: produce a spec file (e.g. `specs/<feature>.plan.md`) that enumerates the scenarios to test. Write a supporting test plan when it aids the requested work; a one-off verification does not require permanent tests or a new spec.

### 1.1 Prerequisite: workspace

Check the workspace has Playwright installed before anything else:

```bash
# Either of these confirms a workspace:
test -f playwright.config.ts || test -f playwright.config.js
npx --no-install playwright --version
```

If no Playwright test setup exists, use the existing browser tools for the live check. Add a test runner or scaffold only when that is within the requested scope; do not bootstrap one solely because this reference suggests it.

### 1.2 Prerequisite: seed test

A **seed test** is a minimal test that lands the page in the state every scenario starts from: navigation to the app, any required login, feature flags, etc. Scenarios assume a fresh start *after* the seed. `--debug=cli` pauses *inside* this test, so the seed is where every planning and generation session begins.

Minimum viable seed:

```ts
// tests/seed.spec.ts
import { test } from '@playwright/test';

test('seed', async ({ page }) => {
  await page.goto('https://example.com/');
});
```

Preferred — push navigation into a fixture so scenario tests reuse it:

```ts
// tests/fixtures.ts
import { test as baseTest } from '@playwright/test';
export { expect } from '@playwright/test';

export const test = baseTest.extend({
  page: async ({ page }, use) => {
    await page.goto('https://example.com/');
    await use(page);
  },
});
```

```ts
// tests/seed.spec.ts
import { test } from './fixtures';

test('seed', async ({ page }) => {
  // Fixture already navigates. This empty body tells agents where to start.
});
```

If no seed exists, create one that at least navigates to the app.

### 1.3 Explore the app

Launch the app via the seed in the background and attach:

```bash
PLAYWRIGHT_HTML_OPEN=never npx playwright test tests/seed.spec.ts --debug=cli
# wait for "Debugging Instructions" and the session name tw-XXXX
playwright-cli attach tw-XXXX
```

Resume so the seed runs, then probe the app:

```bash
playwright-cli resume                   # resume so that seed test runs fully
playwright-cli snapshot                 # inventory of interactive elements
playwright-cli click e5                 # follow a flow
playwright-cli eval "location.href"     # read URL / state
playwright-cli show --annotate          # ask the user to point at something
```

Map out:

- Interactive surfaces (forms, buttons, lists, filters, modals).
- Primary user journeys end-to-end.
- Edge cases: empty states, validation errors, very long input, boundary values.
- Persistence: reload, local/session storage, URL fragments.
- Navigation: which controls change the URL, back/forward behaviour.

Use the existing seed when it supplies required fixtures or authentication; direct navigation is sufficient for checks without test-specific setup.
**Important**: Stop the background test when done exploring.

### 1.4 Write the spec file

Save under `specs/<feature>.plan.md`. Use this structure:

```markdown
# <Feature> Test Plan

## Application Overview

<One paragraph describing what the feature does and why it matters.>

## Test Scenarios

### 1. <Group Name>

**Seed:** `tests/seed.spec.ts`

#### 1.1. <kebab-case-scenario-name>

**File:** `tests/<group>/<kebab-case-scenario-name>.spec.ts`

**Steps:**
  1. <Concrete user step>
    - expect: <observable outcome>
    - expect: <another observable outcome>
  2. <Next step>
    - expect: <outcome>

#### 1.2. <next-scenario>
...

### 2. <Next Group>

**Seed:** `tests/seed.spec.ts`
...
```

Guidelines:

- Each scenario is independent and starts from the seed's fresh state — never chain scenarios.
- Scenario names are kebab-case and match the test file name (`should-add-single-todo` → `should-add-single-todo.spec.ts`).
- Cover happy path, edge cases, validation, negative flows, persistence.
- Write steps at the user level ("Type 'Buy milk' into the input"), not the API level ("call `fill`").
- Put observable outcomes in `- expect:` bullets; each becomes an assertion during generation.

---

## 2. Generate

Goal: take a spec file and produce Playwright test files. Optionally update the spec if it has drifted.

### 2.1 Inputs

- **Spec file**, e.g. `specs/basic-operations.plan.md`.
- **Target**: either a single scenario (e.g. `1.2`), a whole group (`1`), or all.
- **Seed file**, read from the `**Seed:**` line of the scenario's group.

### 2.2 Generate one scenario

Use a fresh seed per scenario. Scenarios sharing a browser or mutable fixtures run sequentially; isolated scenarios may run in parallel:

```bash
PLAYWRIGHT_HTML_OPEN=never npx playwright test <seed-file> --debug=cli   # background
playwright-cli attach tw-XXXX
# resume
```

Run the seed when the scenario depends on its custom setup.

Walk the scenario's `Steps:` with `playwright-cli`. The governing spec/user request defines expected behavior; the live app provides observations. Correct stale locators or unambiguous test-plan wording, but investigate a behavior mismatch before changing expectations. Preserve a regression assertion when the app violates the requirement. Change governed spec content only through its authorized authoring workflow.

Every action prints the equivalent Playwright TypeScript (see [test-generation.md](test-generation.md)):

```bash
playwright-cli snapshot                         # find refs
playwright-cli fill e3 "John Doe"               # -> page.getByRole('textbox', {...}).fill(...)
playwright-cli press Enter
playwright-cli click e7
```

For each `- expect:` bullet, add an explicit assertion. See [test-generation.md](test-generation.md) for details.

Collect the generated code and write the test file at the path given in the spec:

```ts
// spec: specs/basic-operations.plan.md
// seed: tests/seed.spec.ts
import { test, expect } from './fixtures';   // or '@playwright/test' if no fixtures file

test.describe('Singing in and out', () => {
  test('should sign in', async ({ page }) => {
    // 1. Navigate to the application
    // (handled by the seed fixture)

    // 2. Type 'John Doe' into the username field
    await page.getByRole('textbox', { name: 'username' }).fill('John Doe');

    // 3. Type password
    await page.getByRole('textbox', { name: 'password' }).fill('TestPassword');

    // 4. Press Enter to submit
    await page.getByRole('textbox', { name: 'password' }).press('Enter');

    await expect(page.getByRole('heading')).toContainText('Welcome, John Doe!');
  });
});
```

Rules:

- Follow the repository's neighboring test organization; a file may contain cohesive scenarios. Keep scenario IDs traceable without forcing one test per file.
- Use comments for non-obvious setup or constraints, not to repeat every action.
- Use the describe group name verbatim from the spec (no `1.` ordinal).
- Import from `./fixtures` if the project has one; otherwise `@playwright/test`.
- **Important**: close the CLI session and stop the background test before moving to the next scenario.

### 2.3 Generate multiple scenarios

Repeat 2.2 with clean scenario state. Parallelize only when each run has its own browser and isolated mutable fixtures; a unique browser name alone does not isolate backend data. Stop every task-owned debug run.

### 2.4 Run generated tests

After generation, run the new tests once:

```bash
cctl validate run <registered-playwright-command> --json --require-match -- tests/<group>/<scenario>.spec.ts
```

Any failure goes to Section 3.

---

## 3. Heal

Goal: fix failing tests, and update the spec if the app's intended behaviour changed.

### 3.1 Find failing tests

```bash
cctl validate run <registered-playwright-command> --json
```

Record the list of failing `<file>:<line>` entries and process them one at a time. Do not attempt parallel fixes — shared state and the single CLI session make that fragile.

### 3.2 Debug one failure

Run the single failing test in debug mode in the background, then attach:

```bash
PLAYWRIGHT_HTML_OPEN=never npx playwright test tests/<group>/<scenario>.spec.ts:<line> --debug=cli
# wait for "Debugging Instructions" and the tw-XXXX session name
playwright-cli attach tw-XXXX
```

The test is paused at the start. Step forward or run to until just before the failing action or assertion, then diagnose:

```bash
playwright-cli snapshot                # did the element change / move / rename?
playwright-cli console                 # app-side errors?
playwright-cli requests                 # failed request? wrong payload?
playwright-cli show --annotate         # ask the user to point somewhere
```

Common causes: selector drift, new wrapper element, label/ARIA rename, timing (transition, async load), assertion text updated in the app, test data leaking between runs.

Rehearse the corrected interaction with `playwright-cli` — the generated code in the output is what you paste back into the test.

### 3.3 Apply the fix

Fix the responsible layer: update stale test mechanics or implement the authorized application fix. Preserve assertions for intended behavior; do not weaken them merely to make the current app pass. Stop the background debug run. Rerun the single test to confirm green.

Never skip hooks or add sleeps as a fix. Never use `networkidle`.

### 3.4 Reconcile with the spec

Open the spec referenced by the `// spec:` header in the test file and locate the scenario that matches the test.

- **Fix was purely technical** (locator drift, better assertion shape) and the spec's user-level behaviour still matches the app → leave the spec alone.
- **Intended behavior changed with authorization** → update the supporting test plan and expectations to that decision. A native spec amendment follows the spec authoring workflow; do not rewrite approved requirements from observations alone.
- **Unclear whether the app change is intentional** (spec is stale) **or a regression** (test was right, app is wrong) → **first inspect the governing requirements and existing decisions; ask only if intent remains consequentially unresolved**. Provide:
  - the scenario id (e.g. `2.3`),
  - the spec lines that no longer match,
  - the observed app behaviour (quote a snapshot excerpt or a concrete outcome).

Once intent is established, apply the authorized fix or report the regression if implementation is outside scope.

### 3.5 Iteration and giving up

- Fix failures one at a time; rerun after each.
- If the app is wrong, fix it when authorized; otherwise report the failing regression with evidence. Use `test.fixme(...)` only when the user explicitly authorizes deferring that test, with an issue/decision reference.

---

## Cross-references

| For... | See |
|---|---|
| `--debug=cli` / attach mechanics | [playwright-tests.md](playwright-tests.md) |
| How `playwright-cli` actions become TS | [test-generation.md](test-generation.md) |
| Mocking requests during exploration/generation | [request-mocking.md](request-mocking.md) |
| Managing the CLI browser session | [session-management.md](session-management.md) |
