import { recordTestEvent } from "./test-observation.js";
import { checkResolvedArtifactPolicy } from "./artifacts.js";
import { checkParsedInvocation } from "./registry.js";
import { commandErrors } from "./declarations.js";
import { executableRecord, captureExecutable, primaryRenderer, selectRunner } from "./runner-modules.js";
import { checkedResult, checkedWrite, observeWrite, checkedPreparation } from "./execution-reports.js";
import { preparationScope, mintPreparation, usePreparation } from "./preparations.js";
import { assertFields, frozenJson } from "./validation.js";
import { resolveLocalInput } from "./local-input.js";
import { kernelError, kernelErrors, checkedError, unknownAcknowledgmentFact } from "../results.js";
/** Uses only registry path and the already-computed payload hash; no durable ID is invented. */
export function unknownAcknowledgment(invocation, payloadHash) {
    checkParsedInvocation(invocation);
    return unknownAcknowledgmentFact(invocation.command.spec.path, payloadHash);
}
/** Local input/schema validation precedes acquisition. The caller supplies guidance
 * collection and policy resolution as postOperation. After a successful acquisition,
 * await that hook and invoke optional release exactly once in a finally path,
 * including rejection/cancellation. Release failure is secondary, never destructive.
 * No hook or context acquisition is needed for local validation refusals (skipped).
 */
class ContractFailure extends Error {
}
function failure(code, issues) {
    return Object.freeze({ ok: false, error: kernelError(code, { message: kernelErrors[code].description, ...(issues ? { issues } : {}) }) });
}
function outcome(result, operation, renderPrimary = () => "") {
    if (result.ok && operation.effect !== "read" && operation.effect !== "applied")
        throw new TypeError("Invalid successful effect.");
    // Result/effect correlation is checked at this sole execution provenance boundary.
    return Object.freeze({ result, operation: Object.freeze(operation), renderPrimary });
}
// Only the offline constructor grants this origin; handler DTO fields cannot
// opt out of the response owner's primary-renderer protocol restrictions.
const offlineExecutions = new WeakSet();
export function isOfflineExecution(execution) {
    return offlineExecutions.has(execution);
}
/** Composition may repair optional references while preserving the observed operation. */
export function withExecutionResult(execution, result) {
    const retained = outcome(result, execution.operation, execution.renderPrimary);
    if (isOfflineExecution(execution))
        offlineExecutions.add(retained);
    return retained;
}
/** Offline routes have no application operation; reuse the execution outcome owner. */
export function offlineExecution(data, render) {
    const execution = outcome({ ok: true, data: frozenJson(data) }, { effect: "read" }, render);
    offlineExecutions.add(execution);
    return execution;
}
export function usageExecution(issues) {
    // Parser explanations can include a large registry inventory. Optional prose
    // must not prevent construction of the bounded usage response.
    let result;
    try {
        result = failure("KERNEL_USAGE", issues);
    }
    catch {
        result = failure("KERNEL_USAGE", [{ code: "KERNEL_USAGE", message: "Usage details omitted; use --help to inspect accepted commands and inputs." }]);
    }
    return outcome(result, { effect: "read" });
}
function secondary(code) { return Object.freeze({ code, message: kernelErrors[code].description }); }
/** Find the nearest property without invoking getters or bypassing a shadowing accessor. */
function acquisitionProperty(value, key) {
    const visited = new Set();
    let current = value;
    while (current !== null) {
        if (visited.has(current))
            throw new TypeError("Cyclic acquisition prototype.");
        visited.add(current);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor)
            return descriptor;
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}
export async function execute(invocation, request, contexts, postOperation) {
    // Reject foreign/copy tokens before consulting their claimed command metadata.
    checkParsedInvocation(invocation);
    const spec = invocation.command.spec;
    const initial = { effect: spec.effects === "write" && !invocation.validation ? "not_applied" : "read" };
    const errors = commandErrors(invocation.command);
    const local = await resolveLocalInput(invocation, request);
    const skipped = (result) => ({ execution: outcome(result, initial), secondary: [], postOperation: "skipped" });
    if (!local.ok)
        return skipped(failure(local.code, local.issues));
    let run;
    let unknownEffect;
    try {
        run = selectRunner(local.input.module, spec, invocation.input.level);
        if (spec.effects === "write" && !invocation.validation)
            unknownEffect = {
                effect: "unknown", recovery: unknownAcknowledgment(invocation, local.input.payloadHash),
            };
    }
    catch {
        return skipped(failure("KERNEL_CONTRACT"));
    }
    let release;
    let selected = { requires: "none" };
    if (spec.requires !== "none") {
        let providerValue;
        try {
            request.signal.throwIfAborted();
            const providers = executableRecord(contexts);
            const provider = providers[spec.requires];
            if (typeof provider !== "function")
                return skipped(failure("KERNEL_CONTRACT"));
            recordTestEvent(request.signal, { type: "context.acquire", commandPath: spec.path });
            providerValue = await provider({ globals: local.input.globals, env: request.env, host: request.host, signal: request.signal });
        }
        catch {
            return skipped(failure(request.signal.aborted ? "KERNEL_CANCELLED" : "KERNEL_CONTEXT"));
        }
        try {
            if (providerValue === null || typeof providerValue !== "object")
                throw new TypeError("Invalid acquisition result.");
            const releaseProperty = acquisitionProperty(providerValue, "release");
            const finalize = releaseProperty?.value;
            // Arm cleanup before enumerating metadata or requiring app. A class method or
            // non-enumerable release is still available when the rest of the result is invalid.
            if (acquisitionProperty(providerValue, "ok")?.value === true && typeof finalize === "function") {
                release = () => Reflect.apply(finalize, providerValue, []);
            }
            const captured = captureExecutable(providerValue, ["release"]);
            const acquired = captured.fields;
            if (acquired["ok"] === false) {
                if (!captured.valid || releaseProperty)
                    throw new TypeError("Invalid acquisition properties.");
                assertFields(acquired, ["ok", "error"]);
                return skipped({ ok: false, error: checkedError(acquired["error"], errors) });
            }
            if (acquired["ok"] !== true || !Object.hasOwn(acquired, "app"))
                throw new TypeError("Invalid acquisition result.");
            if (!captured.valid)
                throw new TypeError("Invalid acquisition properties.");
            assertFields(acquired, ["ok", "app"]);
            if (releaseProperty && (!("value" in releaseProperty) || finalize !== undefined && typeof finalize !== "function"))
                throw new TypeError("Invalid finalizer.");
            selected = { requires: spec.requires,
                app: acquired["app"] };
        }
        catch {
            const failures = [];
            if (release) {
                try {
                    recordTestEvent(request.signal, { type: "context.release", commandPath: spec.path });
                    await release();
                }
                catch {
                    failures.push(secondary("KERNEL_RELEASE"));
                }
            }
            return { ...skipped(failure("KERNEL_CONTRACT")), secondary: Object.freeze(failures) };
        }
    }
    let operation = initial;
    let result;
    let render = () => "";
    try {
        request.signal.throwIfAborted();
        const ctx = Object.freeze({ command: invocation.command, errors, args: local.input.args, flags: local.input.flags,
            globals: local.input.globals, inputFiles: local.input.inputFiles, env: request.env, host: request.host,
            clock: Object.freeze({ now: request.host.now, sleep: request.host.sleep }), signal: request.signal,
            ...(spec.passthrough ? { passthrough: invocation.input.passthrough ?? [] } : {}) });
        const input = Object.freeze({ ctx, ...(selected.requires === "none" ? {} : { app: selected.app }),
            ...(local.input.decoder ? { payload: local.input.payload } : {}) });
        const payloadMutation = local.input.decoder?.kind === "write";
        let writeReport = spec.effects === "write" && !payloadMutation;
        if (writeReport)
            operation = unknownEffect;
        let returned = await run(input);
        if (payloadMutation) {
            let preparation;
            try {
                preparation = checkedPreparation(returned, errors);
            }
            catch {
                throw new ContractFailure();
            }
            if (!preparation.ok)
                returned = preparation;
            else if (invocation.validation)
                returned = { ok: true, data: { valid: true, payloadHash: local.input.payloadHash } };
            else {
                request.signal.throwIfAborted();
                const hash = local.input.payloadHash;
                if (!hash)
                    throw new ContractFailure();
                const scope = preparationScope(invocation.command, hash);
                const prepared = mintPreparation(scope, preparation.value);
                // The checked mutation wrapper retains the actual commit runner/renderer pairing.
                run = local.input.module["commit"];
                returned = await usePreparation(scope, prepared, hash, async (token) => {
                    operation = unknownEffect;
                    return run(Object.freeze({ ...input, prepared: token }));
                });
                writeReport = true;
            }
        }
        try {
            if (writeReport) {
                const report = captureExecutable(returned);
                operation = observeWrite(report.fields, operation);
                if (!report.valid)
                    throw new TypeError("Invalid commit report properties.");
                result = checkedWrite(report.fields, operation, errors, spec.output === "binary");
            }
            else
                result = checkedResult(returned, errors, spec.output === "binary");
            const data = result.ok && result.binary ? result.binary.summary : result.data;
            render = primaryRenderer(run, data);
        }
        catch {
            result = failure("KERNEL_CONTRACT");
        }
    }
    catch (error) {
        result = failure(request.signal.aborted ? "KERNEL_CANCELLED" : error instanceof ContractFailure ? "KERNEL_CONTRACT" : "KERNEL_HANDLER");
    }
    const execution = outcome(result, operation, render);
    const failures = [];
    let facts;
    try {
        // A selected key was checked against the actual provider map before app binding.
        const hookInput = Object.freeze({ ...selected, command: invocation.command, outcome: execution, inputFiles: local.input.inputFiles,
            env: request.env, host: request.host, signal: request.signal });
        const returned = await postOperation(hookInput);
        const captured = executableRecord(returned);
        assertFields(captured, ["guidance", "issues"], ["artifacts"]);
        if (!Array.isArray(captured["guidance"]) || !Array.isArray(captured["issues"]))
            throw new TypeError("Invalid post-operation facts.");
        const artifacts = captured["artifacts"];
        if (artifacts !== undefined)
            checkResolvedArtifactPolicy(artifacts);
        // Candidate/diagnostic DTOs are detached, but the checked host-only policy
        // retains its owner's identity. JSON cloning it would invalidate delivery.
        facts = Object.freeze({ guidance: frozenJson(returned.guidance), issues: frozenJson(returned.issues),
            ...(artifacts !== undefined ? { artifacts } : {}) });
    }
    catch {
        facts = undefined;
        failures.push(secondary(request.signal.aborted ? "KERNEL_CANCELLED" : "KERNEL_GUIDANCE"));
    }
    finally {
        if (release) {
            try {
                recordTestEvent(request.signal, { type: "context.release", commandPath: spec.path });
                await release();
            }
            catch {
                failures.push(secondary("KERNEL_RELEASE"));
            }
        }
    }
    return Object.freeze({ execution, secondary: Object.freeze(failures),
        ...(facts ? { postOperation: "completed", facts } : { postOperation: "failed" }) });
}
//# sourceMappingURL=execution.js.map