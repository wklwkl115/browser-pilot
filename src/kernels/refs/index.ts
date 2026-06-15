export type BrowserPilotRefKind =
	| "dom"
	| "element"
	| "control"
	| "text"
	| "media"
	| "ax"
	| "region"
	| "frame"
	| "network"
	| "network-entry"
	| "event"
	| "signal"
	| "data-slice"
	| "artifact"
	| "summary"
	| "resource"
	| "target"
	| "memory"
	| "collection";

export type BrowserPilotRef = {
	scheme: "bp-ref";
	kind: BrowserPilotRefKind;
	id: string;
	scope?: string;
};

const BP_REF_PREFIX = "bp-ref://";
const KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]*$/;
const REF_TEXT_PATTERN = /\bbp-ref:\/\/[^\s)]+/g;

export function mintRef(kind: BrowserPilotRefKind, id: string, options: { scope?: string } = {}): string {
	const ref = normalizeRef({ scheme: "bp-ref", kind, id, scope: options.scope });
	const scopedId = ref.scope ? `${encodeURIComponent(ref.scope)}/${ref.id}` : ref.id;
	return `${BP_REF_PREFIX}${ref.kind}/${scopedId}`;
}

export function parseRef(value: string): BrowserPilotRef {
	if (!value.startsWith(BP_REF_PREFIX)) throw new Error("Browser Pilot ref must start with bp-ref://");
	const body = value.slice(BP_REF_PREFIX.length);
	const slash = body.indexOf("/");
	if (slash <= 0 || slash === body.length - 1) throw new Error("Browser Pilot ref must include kind and id");
	const kind = body.slice(0, slash);
	const rest = body.slice(slash + 1);
	const parts = rest.split("/");
	const hasScope = parts.length > 1;
	const ref = normalizeRef({
		scheme: "bp-ref",
		kind: kind as BrowserPilotRefKind,
		id: hasScope ? parts.slice(1).join("/") : rest,
		scope: hasScope ? decodeURIComponent(parts[0] ?? "") : undefined,
	});
	return ref;
}

export function isBrowserPilotRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		parseRef(value);
		return true;
	} catch {
		return false;
	}
}

export function normalizeRef(ref: BrowserPilotRef): BrowserPilotRef {
	if (ref.scheme !== "bp-ref") throw new Error("Browser Pilot ref scheme must be bp-ref");
	if (!KIND_PATTERN.test(ref.kind)) throw new Error(`Invalid Browser Pilot ref kind: ${ref.kind}`);
	if (!ID_PATTERN.test(ref.id)) throw new Error(`Invalid Browser Pilot ref id: ${ref.id}`);
	if (ref.scope !== undefined && !ref.scope.trim()) throw new Error("Browser Pilot ref scope cannot be empty");
	return {
		scheme: "bp-ref",
		kind: ref.kind,
		id: ref.id,
		...(ref.scope ? { scope: ref.scope } : {}),
	};
}

export function refKind(value: string): BrowserPilotRefKind {
	return parseRef(value).kind;
}

export function extractRefsFromText(text: string): string[] {
	const refs: string[] = [];
	for (const match of text.matchAll(REF_TEXT_PATTERN)) {
		const ref = match[0];
		if (isBrowserPilotRef(ref)) refs.push(ref);
	}
	return refs;
}

export function collectRefs(value: unknown): string[] {
	const refs: string[] = [];
	const walk = (item: unknown): void => {
		if (typeof item === "string") {
			if (isBrowserPilotRef(item)) refs.push(item);
			return;
		}
		if (!item || typeof item !== "object") return;
		if (Array.isArray(item)) {
			for (const child of item) walk(child);
			return;
		}
		for (const child of Object.values(item as Record<string, unknown>)) walk(child);
	};
	walk(value);
	return refs;
}
