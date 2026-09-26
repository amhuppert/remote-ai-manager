import { recordTestDelivery } from "./test-observation.js";
import { renderResponse } from "./response.js";
import { bytes } from "../values.js";
import { decodeWireEnvelope, kernelError, protocolLimits } from "../results.js";
import { assertArtifactBasename, binaryBytes } from "./binary.js";
import { ArtifactCollisionError, hasCode } from "./host.js";
import { assertArtifactMetadata, assertFields, boundedSummary, assertRecord, assertSerializedLimit, assertText, frozenJson } from "./validation.js";
/** Framework-owned policy failure; resolver and host exception text never reaches output. */
export class ArtifactPolicyError extends TypeError {
    failure;
    constructor(failure) {
        super(failure.message);
        this.failure = failure;
    }
}
export function captureArtifactPolicy(value) {
    try {
        const snapshot = frozenJson(value);
        assertRecord(snapshot);
        assertFields(snapshot, ["directory", "forbiddenRoots"]);
        assertText(snapshot["directory"]);
        const roots = snapshot["forbiddenRoots"];
        if (!Array.isArray(roots))
            throw new TypeError("Expected forbidden roots.");
        for (const root of roots)
            assertText(root);
        return Object.freeze({ ok: true, policy: snapshot });
    }
    catch {
        return Object.freeze({ ok: false, failure: Object.freeze({ code: "KERNEL_OUTPUT",
                message: "Artifact policy is invalid; expected a directory path and forbidden root paths." }) });
    }
}
function policyError(cause, directory) {
    return new ArtifactPolicyError({ code: "KERNEL_OUTPUT", message: boundedSummary(path => `Artifact directory ${JSON.stringify(path(directory))} ${cause}`, `Artifact directory ${cause} Its path exceeds the diagnostic limit.`, protocolLimits.diagnosticSummary) });
}
function hostCause(error) {
    if (hasCode(error, "ENOTDIR"))
        return "has an ancestor that is not a directory.";
    if (hasCode(error, "EEXIST"))
        return "is a file, not a directory.";
    if (hasCode(error, "EACCES") || hasCode(error, "EPERM"))
        return "could not be accessed; the OS denied permission.";
    if (hasCode(error, "ENOSPC"))
        return "could not be created; the filesystem has no space.";
    return "could not be created or inspected; check permissions and available space.";
}
/** Canonical spellings of missing directories keep a trailing separator. */
function trimmed(path) { return path.replace(/\/+$/, "") || "/"; }
/** Delivery-time preparation of a captured policy: canonicalize, refuse forbidden
 * containment before creating anything, then ensure only the configured root. */
export async function resolveArtifactPolicy(policy, host, signal) {
    const captured = captureArtifactPolicy(policy);
    if (!captured.ok)
        throw new ArtifactPolicyError(captured.failure);
    const configured = captured.policy.directory;
    const step = async (work, cause) => {
        signal.throwIfAborted();
        try {
            return await work();
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw policyError(cause(error), configured);
        }
    };
    try {
        const directory = trimmed(await step(() => host.files.canonicalPath(configured), error => hasCode(error, "ENOTDIR") ? hostCause(error) : "could not be resolved; check its path and symlinks."));
        const forbiddenRoots = (await step(() => Promise.all(captured.policy.forbiddenRoots.map(root => host.files.canonicalPath(root))), () => "could not be checked; a forbidden root could not be resolved.")).map(trimmed);
        if (forbiddenRoots.some(root => within(directory, root)))
            throw policyError("is inside a forbidden root.", configured);
        let kind = await step(() => host.files.kind(directory), hostCause);
        if (kind === "file")
            throw policyError("is a file, not a directory.", configured);
        if (kind === "missing") {
            await step(() => host.files.ensureDirectory(directory, signal), hostCause);
            kind = await step(() => host.files.kind(directory), hostCause);
        }
        if (kind !== "directory")
            throw policyError(hostCause(undefined), configured);
        // Only canonical, validated, detached host data receives the resolved brand.
        const resolved = { directory, forbiddenRoots };
        return frozenJson(resolved);
    }
    catch (error) {
        if (error instanceof ArtifactPolicyError || !signal.aborted)
            throw error;
        throw new ArtifactPolicyError({ code: "KERNEL_CANCELLED", message: "Artifact directory preparation was cancelled." });
    }
}
function within(destination, root) {
    const normalized = trimmed(root);
    return destination === normalized || destination.startsWith(normalized === "/" ? "/" : normalized + "/");
}
class ArtifactWriteError extends TypeError {
}
function artifactWriteError(cause, destination, directory) {
    return new ArtifactWriteError(boundedSummary(path => `Artifact delivery failed for ${JSON.stringify(path(destination))} (artifact directory ${JSON.stringify(path(directory))}): ${cause}`, `Artifact delivery failed: ${cause} Destination and artifact directory paths exceed the diagnostic limit.`, protocolLimits.diagnosticSummary));
}
/** One bounded writer for automatic spill, explicit out and finite binary exports. */
export async function writeArtifact(request, policy, host, signal) {
    if (!(request.bytes instanceof Uint8Array))
        throw new TypeError("Expected finite bytes.");
    const data = new Uint8Array(request.bytes);
    const metadata = frozenJson({ format: request.format, mediaType: request.mediaType, basename: request.basename,
        reason: request.reason, contains: request.contains, ...(request.out !== undefined ? { out: request.out } : {}) });
    assertArtifactBasename(metadata.basename);
    assertArtifactMetadata(metadata);
    if (metadata.out !== undefined)
        assertText(metadata.out);
    signal.throwIfAborted();
    const hash = await host.sha256(new Uint8Array(data));
    if (!/^[a-f0-9]{64}$/.test(hash))
        throw new TypeError("Invalid host SHA256 digest.");
    const path = await import("node:path");
    const target = metadata.out === undefined ? path.join(policy.directory, `${hash}-${metadata.basename}`)
        : path.isAbsolute(metadata.out) ? metadata.out : `${policy.directory}${path.sep}${metadata.out}`;
    let destination;
    try {
        destination = await host.files.canonicalPath(target);
    }
    catch {
        throw artifactWriteError("destination path could not be resolved.", path.resolve(target), policy.directory);
    }
    if (!within(destination, policy.directory) || destination === policy.directory)
        throw artifactWriteError("destination is outside the artifact directory; choose a path inside it.", destination, policy.directory);
    if (policy.forbiddenRoots.some(root => within(destination, root)))
        throw artifactWriteError("destination is inside a forbidden root.", destination, policy.directory);
    let parentKind;
    try {
        parentKind = await host.files.kind(path.dirname(destination));
    }
    catch {
        throw artifactWriteError("parent directory could not be inspected; check access permissions.", destination, policy.directory);
    }
    if (parentKind !== "directory")
        throw artifactWriteError("parent directory does not exist; create it or pass a bare filename to --out.", destination, policy.directory);
    const manifest = { path: destination, format: metadata.format, mediaType: metadata.mediaType,
        bytes: bytes(data.byteLength), sha256: hash, reason: metadata.reason, contains: metadata.contains };
    // Refuse an unreportable path before publishing anything.
    try {
        assertSerializedLimit(manifest, protocolLimits.manifest);
    }
    catch {
        throw artifactWriteError("artifact manifest exceeds its protocol byte limit.", destination, policy.directory);
    }
    signal.throwIfAborted();
    try {
        await host.files.writeAtomic(destination, data, "reuse-identical-or-refuse");
    }
    catch (error) {
        const cause = error instanceof ArtifactCollisionError ? "no-overwrite collision: existing file has different bytes."
            : hasCode(error, "EACCES") || hasCode(error, "EPERM") ? "OS denied write access to the destination or its parent."
                : hasCode(error, "ENOSPC") ? "filesystem has no space for the artifact."
                    : "filesystem write failed; inspect directory permissions and available space.";
        throw artifactWriteError(cause, destination, policy.directory);
    }
    // Publication is acknowledged even if cancellation arrives while it settles.
    return frozenJson(manifest);
}
/** Binary requests always reach writeArtifact; no inline or raw-byte bypass. */
export async function deliverBinary(request, policy, host, signal, out) {
    const data = binaryBytes(request);
    return writeArtifact({ bytes: data, basename: request.basename, mediaType: request.mediaType, format: "binary", contains: "binary",
        reason: out === undefined ? "binary_request" : "explicit_out", ...(out !== undefined ? { out } : {}) }, policy, host, signal);
}
/** Pure pre-execution check; runtime-composition invokes before loading handlers. */
export function validateOutputBudget(budget) {
    const checked = bytes(budget === undefined ? protocolLimits.defaultOutput : budget);
    if (checked < protocolLimits.minimumOutput)
        throw new RangeError("Output budget must be at least 8192 bytes.");
    return checked;
}
/** Count only the final serialized streams, including framing and newlines. */
export function measureOutput(output) {
    const encoder = new TextEncoder();
    return bytes(encoder.encode(output.stdout).byteLength + encoder.encode(output.stderr).byteLength);
}
/** The final bound for every response class. Measures serialized UTF-8 across both
 * streams, spills/omits optional detail and retains valid required protocol fields.
 * Delivery failures preserve primary classification and known effect/recovery;
 * they never re-arbitrate guidance or dump an oversized body. Only this owner
 * constructs bounded RunResult; runtime-composition invokes it after assembly.
 */
export async function deliver(response, options) {
    const budget = validateOutputBudget(options.budget);
    const finish = (output, envelope) => {
        const result = bounded(output, budget);
        recordTestDelivery(options.signal, envelope);
        return result;
    };
    const inline = renderResponse(response, options.format);
    const inlineBytes = measureOutput(inline);
    if (!response.binary && options.out === undefined && inlineBytes <= budget)
        return finish(inline, response.envelope);
    let manifest = response.envelope.payload?.kind === "artifact" ? response.envelope.payload.artifact : undefined;
    let failure;
    if (response.binary || options.out !== undefined || options.artifacts && !manifest) {
        try {
            if (!options.artifacts)
                throw new ArtifactPolicyError({ code: "KERNEL_OUTPUT", message: "Artifact policy is unavailable because the command did not reach policy collection." });
            if (!options.artifacts.ok)
                throw new ArtifactPolicyError(options.artifacts.failure);
            const policy = await resolveArtifactPolicy(options.artifacts.policy, options.host, options.signal);
            if (response.binary)
                manifest = await deliverBinary(response.binary, policy, options.host, options.signal, options.out);
            else {
                const dataOnly = options.out !== undefined && options.format === "json" && response.envelope.payload?.kind === "inline";
                const content = dataOnly && response.envelope.payload?.kind === "inline" ? response.envelope.payload.data : response.envelope;
                manifest = await writeArtifact({ bytes: new TextEncoder().encode(JSON.stringify(content) + "\n"),
                    format: "json", mediaType: "application/json", basename: "response.json",
                    ...(options.out !== undefined ? { out: options.out } : {}),
                    reason: options.out !== undefined ? "explicit_out" : "stdout_budget_exceeded", contains: dataOnly ? "data" : "response" }, policy, options.host, options.signal);
            }
        }
        catch (error) {
            failure = error instanceof ArtifactPolicyError ? error.failure
                : { code: "KERNEL_OUTPUT", message: error instanceof ArtifactWriteError ? error.message : "Artifact delivery failed; optional detail omitted." };
        }
    }
    if (manifest && response.binary && !failure) {
        const envelope = decodeWireEnvelope({ ...response.envelope, payload: { kind: "artifact", artifact: manifest, summary: response.binary.summary } });
        const output = renderResponse({ ...response, envelope, primaryText: `${response.primaryText}\nartifact: ${JSON.stringify(manifest)}`.trimStart() }, options.format);
        if (measureOutput(output) <= budget)
            return finish(output, envelope);
    }
    // An automatic spill is normal delivery: disclose the attempted size, not an issue.
    const spill = manifest?.reason === "stdout_budget_exceeded" ? { format: options.format, inlineBytes, maxBytes: budget } : undefined;
    let envelope = compactEnvelope(response.envelope, manifest, failure, spill);
    let output = projectCompact(response, envelope, manifest, options.format, budget);
    if (measureOutput(output) > budget) {
        envelope = compactEnvelope(response.envelope, manifest, failure, spill, true);
        output = projectCompact(response, envelope, manifest, options.format, budget);
    }
    if (measureOutput(output) > budget && !envelope.ok) {
        // Diagnostic prose is optional detail. Keep the primary code/class/rationale
        // and every secondary code when all protocol groups fill their reservation.
        envelope = decodeWireEnvelope({ ...envelope, error: { ...envelope.error, message: "Primary diagnostic detail omitted." } });
        output = projectCompact(response, envelope, manifest, options.format, budget);
    }
    return finish(output, envelope);
}
function projectCompact(response, envelope, manifest, format, budget) {
    const spill = envelope.payload?.kind === "artifact" ? envelope.payload.spill : undefined;
    const notice = spill ? `notice: response ${spill.inlineBytes} bytes exceeds the ${spill.maxBytes}-byte budget; full response in artifact.\n` : "";
    const compact = { ...response, envelope, primaryText: manifest ? `${notice}artifact: ${JSON.stringify(manifest)}` : "" };
    let output = renderResponse(compact, format);
    if (format === "text" && measureOutput(output) > budget)
        output = renderResponse(compact, "text", true);
    // JSON is also a lossless emergency text representation when prose escaping
    // expands Unicode separators beyond the reservation. Route by classification.
    if (format === "text" && measureOutput(output) > budget) {
        const text = JSON.stringify(envelope) + "\n";
        output = { ...output, stdout: envelope.ok ? text : "", stderr: envelope.ok ? "" : text };
    }
    return output;
}
/** Only measured final streams receive delivery brands. No host/process handles. */
function bounded(output, budget) {
    if (measureOutput(output) > budget)
        throw new RangeError("Mandatory response exceeds the output reservation.");
    return Object.freeze(output);
}
function compactEnvelope(source, manifest, failure, spill, compactSecondary = false) {
    const { payload: _payload, hint: _hint, ...protocol } = source;
    const payload = manifest ? { kind: "artifact", artifact: manifest, summary: { omitted: true }, ...(spill ? { spill } : {}) }
        : { kind: "inline", data: { omitted: true } };
    // Legitimate issues stay while they fit. A complete response artifact discloses any
    // it later drops; only detail with no complete artifact needs an omission issue.
    const complete = manifest?.contains === "response";
    const unavailable = [{ code: "KERNEL_OUTPUT", message: "Optional response detail omitted; no artifact available." }];
    const omitted = [{ code: "KERNEL_OUTPUT", message: manifest ? "Optional diagnostics omitted inline." : "Optional detail and repeated secondary diagnostics omitted." }];
    if (source.ok && !failure)
        return decodeWireEnvelope({ ...protocol, payload,
            issues: !manifest ? unavailable : !compactSecondary ? source.issues : complete ? [] : omitted });
    const primary = source.ok ? kernelError(failure.code, { message: "Artifact delivery failed.", why: failure.message }) : source.error;
    const { details: _details, issues: primaryIssues, ...error } = primary;
    const { issues: _successIssues, ...fields } = protocol;
    const failures = source.ok ? [] : [...source.error.secondary, ...(failure ? [failure] : [])];
    // Preserve full facts when feasible. For unbounded diagnostic counts/details,
    // keep one structured fact per finite catalog code and disclose omitted detail.
    const secondary = compactSecondary ? [...new Set(failures.map(item => item.code))].map(code => ({ code, message: "Omitted." })) : failures;
    const issues = !compactSecondary ? manifest ? primaryIssues : unavailable : complete ? undefined : omitted;
    return decodeWireEnvelope({ ...fields, ok: false, payload, error: { ...error, ...(issues ? { issues } : {}), secondary } });
}
//# sourceMappingURL=artifacts.js.map