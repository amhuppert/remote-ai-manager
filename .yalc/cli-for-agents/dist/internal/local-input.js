import { recordTestEvent } from "./test-observation.js";
import { checkParsedInvocation } from "./registry.js";
import { scalar } from "./input-model.js";
import { kernelError } from "../results.js";
import { commandData } from "./declarations.js";
import { executableRecord, payloadModule } from "./runner-modules.js";
import { assertFields, assertNonnegativeInteger, assertRecord, frozenJson } from "./validation.js";
import { checkedSha256 } from "../values.js";
function schemaIssues(value) {
    if (!Array.isArray(value) || !value.length)
        throw new TypeError("Expected schema issues.");
    const issues = value.map(entry => {
        const issue = executableRecord(entry);
        if (typeof issue["message"] !== "string")
            throw new TypeError("Expected schema issue message.");
        const path = issue["path"];
        if (path !== undefined && !Array.isArray(path))
            throw new TypeError("Expected schema issue path.");
        const normalized = path?.map((part) => {
            const key = typeof part === "object" && part !== null ? executableRecord(part)["key"] : part;
            if (typeof key === "symbol")
                return String(key);
            if (typeof key !== "string")
                assertNonnegativeInteger(key);
            return key;
        });
        return { code: "schema", message: issue["message"], ...(normalized === undefined ? {} : { path: normalized }) };
    });
    // The catalog owner checks diagnostic bounds and normalized path shape.
    return kernelError("KERNEL_INPUT", { message: "Payload schema validation failed.", issues }).issues;
}
export async function resolveLocalInput(invocation, request) {
    let phase = "KERNEL_CONTRACT";
    try {
        checkParsedInvocation(invocation);
        const { input, command } = invocation;
        const { model, handler } = commandData(command);
        const args = { ...input.args };
        const flags = { ...input.flags };
        const globals = { ...input.globals };
        phase = "KERNEL_INPUT";
        request.signal.throwIfAborted();
        if (input.sources.filter(source => source.path === "-").length > 1)
            throw new TypeError("Multiple stdin consumers.");
        for (const credential of input.credentials) {
            const value = Object.hasOwn(request.env, credential.env) ? request.env[credential.env] : undefined;
            if (value === undefined) {
                if (credential.required)
                    throw new TypeError("Missing credential.");
                continue;
            }
            const definition = model.flags[credential.name].definition;
            (credential.global ? globals : flags)[credential.name] = scalar(definition.value, value);
        }
        for (const [name, entry] of Object.entries(model.flags)) {
            if (!entry.definition.fileSource)
                continue;
            const values = entry.global ? globals : flags;
            if (Object.hasOwn(values, name) && new TextEncoder().encode(String(values[name])).byteLength > entry.definition.fileSource.maxBytes) {
                throw new TypeError("Inline text exceeds its source byte limit.");
            }
        }
        let payload;
        let payloadBytes;
        for (const source of input.sources) {
            request.signal.throwIfAborted();
            const data = await (source.path === "-" ? request.host.files.readStdin(source.maxBytes, request.signal)
                : request.host.files.read(source.path, source.maxBytes, request.signal));
            request.signal.throwIfAborted();
            if (!(data instanceof Uint8Array) || data.byteLength > source.maxBytes)
                throw new TypeError("Invalid bounded read.");
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
            if (source.kind === "payload") {
                payload = frozenJson(JSON.parse(text));
                payloadBytes = new Uint8Array(data);
            }
            else if (source.kind === "argument")
                args[source.name] = text;
            else {
                const definition = model.flags[source.name].definition;
                (source.kind === "global" ? globals : flags)[source.name] = definition.value.kind === "file" ? text : scalar(definition.value, text);
            }
        }
        phase = "KERNEL_CONTRACT";
        recordTestEvent(request.signal, { type: "handler.load", commandPath: command.spec.path });
        const loaded = await handler();
        request.signal.throwIfAborted();
        if (loaded === null || typeof loaded !== "object")
            throw new TypeError("Expected a lazy module namespace.");
        // ESM namespaces include Symbol.toStringTag and may have unrelated named exports.
        // Capture only the declared default export, without invoking arbitrary getters.
        const exported = Object.getOwnPropertyDescriptor(loaded, "default");
        if (!exported?.enumerable || !("value" in exported))
            throw new TypeError("Missing lazy default export.");
        const defaultExport = exported.value;
        let module;
        let decoder;
        if (model.spec.payload) {
            decoder = payloadModule(defaultExport, model.spec.effects);
            module = decoder.handler;
            phase = "KERNEL_INPUT";
            const result = await decoder.decode["~standard"].validate(payload);
            request.signal.throwIfAborted();
            phase = "KERNEL_CONTRACT";
            const checked = executableRecord(result);
            if (checked["issues"] !== undefined) {
                assertFields(checked, ["issues"]);
                return { ok: false, code: "KERNEL_INPUT", issues: schemaIssues(checked["issues"]) };
            }
            assertFields(checked, ["value"], ["issues"]);
            payload = checked["value"];
        }
        else
            module = Object.freeze(executableRecord(defaultExport));
        let payloadHash;
        if (decoder?.kind === "write") {
            if (!payloadBytes)
                throw new TypeError("Missing payload bytes.");
            payloadHash = checkedSha256(await request.host.sha256(payloadBytes));
            request.signal.throwIfAborted();
        }
        const inputFiles = input.sources
            .filter(source => source.kind === "argument" || source.kind === "payload" || !model.flags[source.name]?.definition.secret)
            .map(({ kind, name, path }) => ({ kind, name, path }));
        const resolved = frozenJson({ args, flags, globals, inputFiles });
        assertRecord(resolved);
        return { ok: true, input: Object.freeze({ ...resolved, module, ...(decoder ? { decoder, payload } : {}), ...(payloadHash ? { payloadHash } : {}) }) };
    }
    catch {
        return { ok: false, code: request.signal.aborted ? "KERNEL_CANCELLED" : phase };
    }
}
//# sourceMappingURL=local-input.js.map