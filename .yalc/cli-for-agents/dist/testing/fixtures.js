import { commandsFor, invocation, payloadRead } from "../commands.js";
import { defineErrors, recoveryFacts } from "../results.js";
import { bytes, count } from "../values.js";
import { page } from "../disclosure.js";
import { createCli, renderInvocation } from "../runtime/index.js";
import { defineSteering, evaluateGuidance, instruction, hint } from "../guidance/index.js";
import { cliRegistry, registryState } from "../internal/registry.js";
import { createTestHost, runForTest } from "./index.js";
const budget = bytes(8192);
const output = { maxBytes: budget, artifacts: { directory: "/artifacts", forbiddenRoots: [] } };
const base = { path: "inspect", summary: "Inspect", description: "Inspect state", requires: "none", effects: "read", args: [], flags: {} };
const host = () => createTestHost({ files: { "/artifacts/.keep": "", "/input.json": "{}" } });
async function json(cli, argv, injected) {
    const result = await runForTest(cli, argv, { host: injected, format: "json" });
    if (result.format !== "json")
        throw new Error("Expected JSON fixture result.");
    return result;
}
async function pair(cli, argv, injected) {
    return { json: await json(cli, argv, injected), text: await runForTest(cli, argv, { host: injected, format: "text" }) };
}
function foundation() {
    const family = commandsFor()({ errors: defineErrors({}), globalFlags: {} });
    const doctor = family.defineCommand({ ...base, path: "doctor" }, { examples: [{ why: "Diagnose" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: {} }) } }) });
    return { family, doctor, common: { name: "contract-tool", version: "1", family, contexts: {}, output, doctor: invocation(doctor, {}) } };
}
/** Fresh in-memory runtime fixtures. Only offline cases target the supplied
 * consumer registry; executable pilots provide all seven callbacks to exercise
 * their own domain/transport paths. No fixture runs during module import. */
export function createContractFixtures(consumer) {
    return {
        async "offline-paths"() {
            const runs = [await runForTest(consumer, ["--version"], { host: host(), format: "json" })];
            const paths = Object.keys(registryState(cliRegistry(consumer)).nodes);
            for (const format of ["text", "json"]) {
                for (const path of paths)
                    runs.push(await runForTest(consumer, [...(path ? path.split(" ") : []), "--help"], { host: host(), format }));
                for (const argv of [["--version"], ["exit-codes"], ["--!testkit-invalid"]]) {
                    runs.push(await runForTest(consumer, argv, { host: host(), format }));
                }
            }
            return { runs };
        },
        async "schema-issue-survival"() {
            const family = commandsFor()({ errors: defineErrors({}), globalFlags: {} });
            const doctor = family.defineCommand({ ...base, path: "doctor" }, { examples: [{ why: "Diagnose" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: {} }) } }) });
            const command = family.defineCommand({ ...base, requires: "network", payload: { maxBytes: bytes(256) } }, {
                examples: [{ why: "Check schema", file: "/input.json" }], handler: async () => ({ default: payloadRead({
                        decode: { "~standard": { version: 1, vendor: "contract-fixture", validate: () => ({ issues: [{ message: "Name is required", path: ["records", 0, "name"] }] }) } },
                        run: async () => ({ ok: true, data: {} }),
                    }) }),
            });
            const cli = createCli({ name: "schema-contract", version: "1", family, commands: [doctor, command], contexts: { network: async () => { throw new Error("Schema failure must precede acquisition"); } }, output, doctor: invocation(doctor, {}) });
            return { ...await pair(cli, ["inspect", "--file", "/input.json"], host()), expectedIssues: [{ code: "schema", message: "Name is required", path: ["records", 0, "name"] }] };
        },
        async "single-guidance-arbitration"() {
            const { family, doctor, common } = foundation();
            const command = family.defineCommand(base, { examples: [{ why: "Conflict" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: {}, instruction: instruction("handler", "Inspect local state.") }) } }) });
            const cli = createCli({ ...common, commands: [doctor, command], guidance: {
                    load: async () => ({ default: async () => evaluateGuidance({ command, authority: "remote", state: {}, rules: [defineSteering({ id: "remote-step", appliesTo: [command], when: () => true, tier: "instruction", render: () => instruction("remote", "Inspect remote state.") })], eventSink: () => { } }) }),
                    conflictSink: () => { },
                } });
            return pair(cli, ["inspect"], host());
        },
        async "unknown-totals"() {
            const { family, doctor, common } = foundation();
            const continuation = invocation(doctor, {});
            const command = family.defineCommand(base, { examples: [{ why: "Page" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: page({ items: [{ id: "item-1" }], total: { kind: "unknown" }, more: true, reveal: continuation }) }) } }) });
            const cli = createCli({ ...common, commands: [doctor, command] });
            return { json: await json(cli, ["inspect"], host()), continuation, returned: count(1) };
        },
        async "shell-safe-references"() {
            const { family, doctor, common } = foundation();
            const target = family.defineCommand({ ...base, path: "find", flags: { query: { description: "Query", value: { kind: "string" } } } }, { examples: [{ why: "Find" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: {} }) } }) });
            const reference = invocation(target, { flags: { query: "a b' $(touch nope); `echo nope` \\" } });
            const command = family.defineCommand(base, { examples: [{ why: "Guide" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: {}, hint: hint(reference, "Inspect matching records") }) } }) });
            const executable = "tool path's";
            const cli = createCli({ ...common, name: executable, commands: [doctor, target, command] });
            return { json: await json(cli, ["inspect"], host()), reference, executable, rendered: renderInvocation(reference, executable) };
        },
        async "unicode-spill"() {
            const { family, doctor, common } = foundation();
            let content = "";
            const command = family.defineCommand(base, { examples: [{ why: "Spill" }], handler: async () => ({ default: { run: async () => ({ ok: true, data: { content } }) } }) });
            const cli = createCli({ ...common, commands: [doctor, command] });
            const injected = host();
            const empty = await json(cli, ["inspect"], injected);
            const remaining = budget - new TextEncoder().encode(empty.stdout).byteLength;
            content = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
            const inline = await json(cli, ["inspect"], injected);
            content += "😀";
            const expectedSpill = JSON.stringify({ ...inline.envelope, payload: { kind: "inline", data: { content } } }) + "\n";
            const spilled = await json(cli, ["inspect"], injected);
            const manifest = spilled.artifacts[0];
            return { inline, spilled, budget, expectedSpill, artifactBytes: manifest ? injected.filesSnapshot()[manifest.path] ?? new Uint8Array() : new Uint8Array() };
        },
        async "operation-recovery"() {
            const { family, doctor, common } = foundation();
            const recovery = recoveryFacts([{ kind: "receipt", id: "saved-42" }]);
            const required = "Inspect saved state before another mutation.";
            const command = family.defineCommand({ ...base, effects: "write" }, { examples: [{ why: "Write" }], handler: async () => ({ default: { run: async () => ({ effect: "applied", recovery, result: { ok: true, data: { content: "😀".repeat(4000) }, instruction: instruction("operation", required) } }) } }) });
            const cli = createCli({ ...common, commands: [doctor, command] });
            const injected = host();
            const failing = { ...injected, files: { ...injected.files, writeAtomic: async () => { throw new Error("Deliberate artifact failure"); } } };
            return { ...await pair(cli, ["inspect"], failing), effect: "applied", recovery, instruction: required };
        },
    };
}
//# sourceMappingURL=fixtures.js.map