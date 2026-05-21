import { createHash } from "node:crypto";
import { invalidDesired } from "./orchestrationErrors";
import type { JsonRecord, NormalizedPreNavigationHookMetadata, NormalizedDesiredTab, PreNavigationHookRegistryEntry } from "./types";

const PRE_NAVIGATION_MARKER_BYTES = `(() => {
	const key = "__PI_BROWSER_PRE_NAVIGATION_HOOKS__";
	const marker = { hookId: "pi.preNavigationMarker", version: "1", installedAt: Date.now(), readyState: document.readyState };
	const current = Array.isArray(globalThis[key]) ? globalThis[key] : [];
	current.push(marker);
	try { Object.defineProperty(globalThis, key, { value: current, configurable: true, writable: true }); }
	catch { globalThis[key] = current; }
})();`;

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export type ResolvedPreNavigationHook = PreNavigationHookRegistryEntry & {
	bytes: string;
	worldName?: string;
	effectExpression: string;
};

const BUILTIN_PRE_NAVIGATION_HOOKS: ResolvedPreNavigationHook[] = [{
	hookId: "pi.preNavigationMarker",
	version: "1",
	hash: sha256(PRE_NAVIGATION_MARKER_BYTES),
	builtin: true,
	assetPath: "builtin:pi.preNavigationMarker@1",
	bytes: PRE_NAVIGATION_MARKER_BYTES,
	effectExpression: "Array.isArray(globalThis.__PI_BROWSER_PRE_NAVIGATION_HOOKS__) && globalThis.__PI_BROWSER_PRE_NAVIGATION_HOOKS__.some((item) => item && item.hookId === 'pi.preNavigationMarker' && item.version === '1')",
}];

export function listPreNavigationHookRegistry(): PreNavigationHookRegistryEntry[] {
	return BUILTIN_PRE_NAVIGATION_HOOKS.map(({ bytes: _bytes, worldName: _worldName, effectExpression: _effectExpression, ...entry }) => ({ ...entry }));
}

export function preNavigationHookRegistryHash(hookId = "pi.preNavigationMarker", version = "1"): string {
	const entry = BUILTIN_PRE_NAVIGATION_HOOKS.find((item) => item.hookId === hookId && item.version === version);
	if (!entry) throw invalidDesired("preNavigationHook registry entry is not found", { hookId, version });
	return entry.hash;
}

export function preNavigationHookKey(hook: Pick<NormalizedPreNavigationHookMetadata, "hookId" | "version" | "hash">): string {
	return `${hook.hookId}@${hook.version}:${hook.hash}`;
}

export function resolvePreNavigationHook(hook: Pick<NormalizedPreNavigationHookMetadata, "hookId" | "version" | "hash">): ResolvedPreNavigationHook {
	const entry = BUILTIN_PRE_NAVIGATION_HOOKS.find((item) => item.hookId === hook.hookId && item.version === hook.version);
	if (!entry) throw invalidDesired("preNavigationHook registry entry is not found", { hookId: hook.hookId, version: hook.version });
	if (entry.hash !== hook.hash) throw invalidDesired("preNavigationHook hash does not match registry entry", { hookId: hook.hookId, version: hook.version, expectedHash: entry.hash, providedHash: hook.hash });
	return entry;
}

export function preNavigationHookAppliesToTab(hook: NormalizedPreNavigationHookMetadata, tab: Pick<NormalizedDesiredTab, "role" | "origin">): boolean {
	if (!hook.enabled) return false;
	if (hook.scope.tabRoles?.length && !hook.scope.tabRoles.includes(tab.role)) return false;
	if (hook.scope.origins?.length && !hook.scope.origins.includes(tab.origin)) return false;
	return true;
}

export function preNavigationHooksForTab<T extends Pick<NormalizedPreNavigationHookMetadata, "enabled" | "scope">>(hooks: T[], tab: Pick<NormalizedDesiredTab, "role" | "origin">): T[] {
	return hooks.filter((hook) => preNavigationHookAppliesToTab(hook as NormalizedPreNavigationHookMetadata, tab));
}

export function compactPreNavigationHookMetadata(hook: NormalizedPreNavigationHookMetadata): JsonRecord {
	return {
		hookId: hook.hookId,
		version: hook.version,
		hash: hook.hash,
		hashPrefix: hook.hash.slice(0, 19),
		required: hook.required,
		scope: hook.scope,
		installPhase: hook.installPhase,
	};
}
