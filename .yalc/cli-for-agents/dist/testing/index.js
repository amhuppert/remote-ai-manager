import { inheritedCases } from "./contracts.js";
import { createContractFixtures } from "./fixtures.js";
export { createContractFixtures } from "./fixtures.js";
export { expectDisclosureParity } from "./contracts.js";
import { captureHost } from "../internal/test-host-capture.js";
import { makeTestHost } from "../internal/test-host.js";
import { cliConfiguration, cliRegistry, commandCli, checkMembership, rebindInvocation, resolve } from "../internal/registry.js";
import { invocationArgv } from "../internal/invocations.js";
import { observeRun } from "../internal/test-observation.js";
import { createCli, runCli, decodeEnvelope } from "../runtime/index.js";
export function createTestHost(options) { return makeTestHost(options); }
export async function runForTest(cli, input, options) {
    const configuration = cliConfiguration(cli);
    const registry = cliRegistry(cli);
    let tokens;
    if (Array.isArray(input))
        tokens = input;
    else
        tokens = invocationArgv(rebindInvocation(registry, input));
    if (options.format !== "text" && options.format !== "json")
        throw new TypeError("Invalid test format.");
    const initial = resolve(registry, tokens);
    const initialJson = initial.kind === "leaf" ? initial.invocation.json : initial.json;
    const argv = initialJson === (options.format === "json") ? [...tokens] : [`--json=${options.format === "json"}`, ...tokens];
    const resolution = resolve(registry, argv);
    const json = resolution.kind === "leaf" ? resolution.invocation.json : resolution.json;
    if (json !== (options.format === "json"))
        throw new TypeError("Input conflicts with test format.");
    let selected = cli;
    if (options.contexts !== undefined) {
        const supplied = options.contexts;
        const keys = Object.keys(configuration.contexts);
        if (!supplied || keys.some(key => !Object.hasOwn(supplied, key))
            || Object.keys(supplied).some(key => !keys.includes(key)))
            throw new TypeError("Test contexts must match the CLI context keys.");
        // Provider keys and concrete values are checked above; preserve the bound map.
        const contexts = { ...configuration.contexts };
        for (const key of keys) {
            contexts[key] = async () => ({ ok: true, app: supplied[key] });
        }
        selected = createCli({ ...configuration, contexts });
    }
    const controller = new AbortController();
    const observation = { events: [] };
    const stop = observeRun(controller.signal, observation);
    const calls = [];
    const host = captureHost(options.host, calls);
    try {
        const result = await runCli(selected, { argv, env: options.env ?? {}, host, signal: controller.signal });
        const delivered = observation.envelope;
        if (!delivered)
            throw new Error("Runtime did not capture delivery evidence.");
        const evidence = { ...result,
            artifacts: Object.freeze(delivered.payload?.kind === "artifact" ? [delivered.payload.artifact] : []),
            calls: Object.freeze([...calls]), events: Object.freeze([...observation.events]) };
        return options.format === "json"
            ? Object.freeze({ ...evidence, format: "json", envelope: decodeEnvelope(JSON.parse(result.stdout)) })
            : Object.freeze({ ...evidence, format: "text" });
    }
    finally {
        stop();
    }
}
/** Runner-neutral checks; supply all scenarios to test a consumer's own paths. */
export function contractTests(cli, fixtures = createContractFixtures(cli)) {
    return inheritedCases(cli, fixtures);
}
export function expectBounded(result, budget) {
    if (!Number.isSafeInteger(budget) || budget < 0)
        throw new TypeError("Invalid byte bound.");
    const encoder = new TextEncoder();
    const measured = encoder.encode(result.stdout).byteLength + encoder.encode(result.stderr).byteLength;
    if (measured > budget)
        throw new Error(`Output exceeds byte bound: ${measured} > ${budget}.`);
}
/** Checks help/version/catalog/parse refusals through the registered CLI. Pass cli
 * explicitly when the same command belongs to several registries. Declaration
 * import graphs are checked separately by distribution guards. */
export async function expectLazy(command, cli = commandCli(command)) {
    checkMembership(cliRegistry(cli), command);
    // The declaration name grammar rejects !, so this probe cannot execute a leaf.
    const path = command.spec.path.split(" ");
    for (const argv of [[...path, "--help"], ["--version"], ["exit-codes"], [...path, "--!testkit-invalid"]]) {
        const result = await runForTest(cli, argv, { host: createTestHost(), format: "json" });
        if (result.events.some(event => event.type === "handler.load" || event.type === "context.acquire"))
            throw new Error("Offline path evaluated a lazy handler/context.");
        if (result.exitCode !== (argv.includes("--!testkit-invalid") ? 2 : 0))
            throw new Error("Offline path returned an unexpected exit code.");
    }
}
//# sourceMappingURL=index.js.map