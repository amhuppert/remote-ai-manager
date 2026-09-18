import { recordTestEvent } from "./test-observation.js";
import { nodeHost } from "../runtime/index.js";
import { checkedError, kernelErrors } from "../results.js";
import { hint } from "../guidance/index.js";
import { cliConfiguration, cliRegistry, resolve, rebindInvocation } from "./registry.js";
import { execute, offlineExecution, usageExecution, withExecutionResult } from "./execution.js";
import { checkEvaluatedGuidance } from "./guidance-rules.js";
import { frozenJson } from "./validation.js";
import { renderOffline } from "./help.js";
import { arbitrate, assembleResponse } from "./response.js";
import { deliver, resolveArtifactPolicy, validateOutputBudget } from "./artifacts.js";
const diagnostic = (code) => ({ code, message: kernelErrors[code].description });
/** Collect independent sources while the execution owner still holds the app. */
async function collect(registry, input, source, load) {
    let guidance;
    const issues = [];
    if (load) {
        let provided;
        let returned = false;
        try {
            provided = await (await load()).default(input);
            returned = true;
        }
        catch {
            issues.push(diagnostic(input.signal.aborted ? "KERNEL_CANCELLED" : "KERNEL_GUIDANCE"));
        }
        if (returned) {
            try {
                const checked = checkEvaluatedGuidance(provided);
                if (checked.commandPath !== input.command.spec.path)
                    throw new TypeError("Wrong guidance command.");
                const candidates = checked.candidates.filter(candidate => {
                    if (candidate.tier !== "hint")
                        return true;
                    try {
                        rebindInvocation(registry, candidate.value.invocation);
                        return true;
                    }
                    catch {
                        issues.push(diagnostic("KERNEL_CONTRACT"));
                        return false;
                    }
                });
                const ids = new Set(candidates.map(candidate => candidate.provenance.ruleId));
                for (const event of checked.firings)
                    recordTestEvent(input.signal, event);
                guidance = frozenJson({ ...checked, candidates, firings: checked.firings.filter(event => ids.has(event.ruleId)) });
            }
            catch {
                issues.push(diagnostic("KERNEL_CONTRACT"));
            }
        }
    }
    let artifacts;
    try {
        artifacts = await resolveArtifactPolicy("resolve" in source ? await source.resolve(input) : source, input.host);
    }
    catch {
        issues.push(diagnostic(input.signal.aborted ? "KERNEL_CANCELLED" : "KERNEL_OUTPUT"));
    }
    return { issues, ...(guidance ? { guidance } : {}), ...(artifacts ? { artifacts } : {}) };
}
/** The public production caller: owners retain parsing, lifetime, arbitration and bounds. */
export async function runProduction(cli, request) {
    const options = cliConfiguration(cli);
    const registry = cliRegistry(cli);
    const resolution = resolve(registry, request.argv);
    const json = resolution.kind === "leaf" ? resolution.invocation.json : resolution.json;
    let budget;
    let execution;
    let facts;
    let secondary = [];
    let invalidBudget = false;
    try {
        budget = validateOutputBudget(options.output.maxBytes);
    }
    catch {
        budget = validateOutputBudget();
        invalidBudget = true;
    }
    // Offline projection runs before loading execution dependencies or acquiring a host.
    const offline = !invalidBudget && resolution.kind === "offline"
        ? await renderOffline(cli, { ...resolution, json: false }, request) : undefined;
    const host = request.host ?? await nodeHost();
    if (invalidBudget)
        execution = usageExecution([{ code: "KERNEL_USAGE", message: "Output budget must be a safe integer of at least 8192 bytes." }]);
    else if (resolution.kind === "invalid")
        execution = usageExecution(resolution.issues);
    else if (offline)
        execution = offlineExecution(offline.data, () => offline.stdout);
    else if (resolution.kind === "leaf") {
        const completed = await execute(resolution.invocation, { ...request, host }, options.contexts, input => collect(registry, input, options.output.artifacts, options.guidance?.load));
        execution = completed.execution;
        facts = completed.facts;
        secondary = completed.secondary;
    }
    else
        throw new TypeError("Unresolved offline route.");
    // References are shaped by their original owner but must be runnable in this CLI.
    // Remove an invalid optional reference without erasing domain/effect facts.
    const referenceFailures = [];
    let result = execution.result;
    if (result.hint) {
        try {
            result = { ...result, hint: hint(rebindInvocation(registry, result.hint.invocation), result.hint.action) };
        }
        catch {
            const { hint: _invalid, ...retained } = result;
            result = retained;
            referenceFailures.push({ code: "KERNEL_CONTRACT", message: "Handler hint references an invalid invocation." });
        }
    }
    if (!result.ok && result.error.continuation) {
        try {
            rebindInvocation(registry, result.error.continuation);
        }
        catch {
            const { continuation: _invalid, ...retained } = result.error;
            result = { ...result, error: checkedError(retained, options.family.errors) };
            referenceFailures.push({ code: "KERNEL_CONTRACT", message: "Continuation references an invalid invocation." });
        }
    }
    execution = withExecutionResult(execution, result);
    recordTestEvent(request.signal, { type: "guidance.arbitrate" });
    const guidance = await arbitrate({ commandPath: resolution.kind === "leaf" ? resolution.invocation.command.spec.path : "",
        handler: result.instruction ? { instruction: result.instruction } : result.hint ? { hint: result.hint } : {},
        ...(facts?.guidance ? { evaluated: facts.guidance } : {}), conflictSink: async (event) => {
            recordTestEvent(request.signal, event);
            await options.guidance?.conflictSink(event);
        } });
    const assembled = await assembleResponse(execution, { guidance, doctor: options.doctor, executable: options.name,
        secondary: [...secondary, ...referenceFailures, ...(facts?.issues ?? []).map(issue => {
                if (!Object.hasOwn(kernelErrors, issue.code))
                    throw new TypeError("Unknown hook failure code.");
                return { code: issue.code, message: issue.message };
            })] });
    return deliver(assembled, { format: json ? "json" : "text", budget, host, signal: request.signal,
        ...(facts?.artifacts ? { artifacts: facts.artifacts } : {}),
        ...(resolution.kind === "leaf" && resolution.invocation.input.out !== undefined ? { out: resolution.invocation.input.out } : {}) });
}
//# sourceMappingURL=runtime.js.map