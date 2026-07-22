import type { ResourceRefDescriptor as RefDescriptor } from "../resources/resourceRefs.js";
import { stdlibPrelude } from "./executeStdlibPrelude.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { MAX_EXECUTION_REFS, resolveExecutionRef, type ExecutionRefTarget } from "./executionRef.js";

export type PreparedExecuteScript = {
	script: string;
	targetRefs: ExecutionRefTarget[];
};

function pageDescriptor(descriptor: RefDescriptor): Pick<RefDescriptor, "refId" | "locators" | "geometry"> {
	return {
		refId: descriptor.refId,
		locators: descriptor.locators.filter((locator) => locator.by === "css" || locator.by === "xpath" || locator.by === "attrSignature"),
		geometry: descriptor.geometry,
	};
}

function buildRefRegistry(refUris: string[]): { registry: Record<string, unknown>; targetRefs: ExecutionRefTarget[] } {
	const registry: Record<string, unknown> = {};
	const targetRefs: ExecutionRefTarget[] = [];
	for (const uri of refUris) {
		const resolved = resolveExecutionRef(uri);
		targetRefs.push(resolved.target);
		registry[uri] = {
			ok: true,
			fresh: resolved.target.fresh,
			descriptor: pageDescriptor(resolved.descriptor),
		};
	}
	return { registry, targetRefs };
}

export function prepareExecuteStdlib(script: string, options: { refs?: Record<string, string> } = {}): PreparedExecuteScript {
	const bindings = options.refs ?? {};
	const bindingCount = Object.keys(bindings).length;
	const refUris = Array.from(new Set(Object.values(bindings)));
	if (bindingCount > MAX_EXECUTION_REFS) throw new BrowserBridgeError("INVALID_RULE", `browser_execute accepts at most ${MAX_EXECUTION_REFS} refs`, { refCount: bindingCount });
	if (!refUris.length && !/\bbrowserPilot\s*\./.test(script)) return { script, targetRefs: [] };
	const registry = buildRefRegistry(refUris);
	return {
		script: `${stdlibPrelude(registry.registry, bindings)}\n${script}`,
		targetRefs: registry.targetRefs,
	};
}
