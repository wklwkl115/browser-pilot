/**
 * Compiles SemanticActionV1 into existing trusted Program Engine primitives.
 * Frames must match programOps discriminator schema (mouse/key/text/wait/eval).
 * Does not implement hit-test, editable detection, or completion classification.
 */
import type { AgentCandidateBinding, SemanticActionV1 } from "../kernels/agent/agentTypes.js";
import { isPublishedWriteKind, resolverIdForKind, type SemanticCompletionResolverId } from "../kernels/agent/semanticAction.js";
import { validateProgram } from "./programDispatcher.js";

export type TrustedProgramPrimitive = Record<string, unknown>;

export type CompiledSemanticAction = {
	actionKind: SemanticActionV1["kind"];
	physical: boolean;
	targetBindings: AgentCandidateBinding[];
	execution:
		| { kind: "program"; program: TrustedProgramPrimitive[] }
		| { kind: "navigation"; plan: { type: "navigate" | "history"; url?: string; direction?: string; disposition?: string } };
	completionResolverId: SemanticCompletionResolverId;
	safety: {
		requiresConfirmation: boolean;
		confirmationReason?: string;
	};
	debugPlan: {
		kind: SemanticActionV1["kind"];
		resourceRefs: string[];
		frames: number;
	};
};

export type CompileError = {
	code: "ACTION_NOT_ALLOWED" | "ACTION_UNSUPPORTED_SURFACE" | "REF_STALE" | "INVALID_AGENT_REQUEST";
	message: string;
};

function requireBinding(
	ref: string | undefined,
	bindings: Map<string, AgentCandidateBinding>,
): AgentCandidateBinding | CompileError {
	if (!ref) return { code: "INVALID_AGENT_REQUEST", message: "action requires a candidate ref" };
	const binding = bindings.get(ref);
	if (!binding) return { code: "REF_STALE", message: `unknown or stale candidate ref ${ref}` };
	return binding;
}

function isCompileError(value: AgentCandidateBinding | CompileError): value is CompileError {
	return "code" in value && "message" in value && !("resourceRef" in value);
}

/** Map semantic key names to KeyboardEvent.code values used by the key op. */
export function toKeyboardEventCode(key: string): string {
	const raw = key.trim();
	if (!raw) return "Unidentified";
	const aliases: Record<string, string> = {
		enter: "Enter",
		return: "Enter",
		tab: "Tab",
		escape: "Escape",
		esc: "Escape",
		backspace: "Backspace",
		delete: "Delete",
		del: "Delete",
		space: "Space",
		" ": "Space",
		arrowup: "ArrowUp",
		arrowdown: "ArrowDown",
		arrowleft: "ArrowLeft",
		arrowright: "ArrowRight",
		home: "Home",
		end: "End",
		pageup: "PageUp",
		pagedown: "PageDown",
	};
	const lower = raw.toLowerCase();
	if (aliases[lower]) return aliases[lower]!;
	if (/^key[a-z]$/i.test(raw) || /^digit[0-9]$/i.test(raw) || /^f\d{1,2}$/i.test(raw)) {
		return raw[0]!.toUpperCase() + raw.slice(1);
	}
	if (/^[a-z]$/i.test(raw)) return `Key${raw.toUpperCase()}`;
	if (/^[0-9]$/.test(raw)) return `Digit${raw}`;
	// Already a plausible KeyboardEvent.code (Enter, ControlLeft, …)
	if (/^[A-Z][A-Za-z0-9]+$/.test(raw)) return raw;
	return raw;
}

function mapModifiers(modifiers: string[] | undefined): Array<"ctrl" | "shift" | "alt" | "meta"> | undefined {
	if (!modifiers?.length) return undefined;
	const out: Array<"ctrl" | "shift" | "alt" | "meta"> = [];
	for (const mod of modifiers) {
		const m = mod.toLowerCase();
		if (m === "ctrl" || m === "control") out.push("ctrl");
		else if (m === "shift") out.push("shift");
		else if (m === "alt") out.push("alt");
		else if (m === "meta" || m === "cmd" || m === "command") out.push("meta");
	}
	return out.length ? out : undefined;
}

/** Trusted left-click: press then release at the same ref. */
function clickProgram(resourceRef: string): TrustedProgramPrimitive[] {
	return [
		{ mouse: "press", ref: resourceRef, button: "left" },
		{ mouse: "release", ref: resourceRef, button: "left" },
	];
}

/**
 * Platform select-all chord for fill replace.
 * macOS uses Meta+A; other platforms use Control+A.
 * Injected platform string keeps kernels free of Node process dependency at compile call sites.
 */
export function selectAllProgram(platform: string = typeof process !== "undefined" ? process.platform : "linux"): TrustedProgramPrimitive[] {
	const isDarwin = platform === "darwin";
	const modKey = isDarwin ? "MetaLeft" : "ControlLeft";
	const mod: "meta" | "ctrl" = isDarwin ? "meta" : "ctrl";
	return [
		{ key: "down", code: modKey },
		{ key: "down", code: "KeyA", modifiers: [mod] },
		{ key: "up", code: "KeyA", modifiers: [mod] },
		{ key: "up", code: modKey },
	];
}

function assertProgramValid(program: TrustedProgramPrimitive[]): CompileError | undefined {
	const validation = validateProgram(program);
	if (!validation.ok) {
		return { code: "INVALID_AGENT_REQUEST", message: `compiled program invalid: ${validation.error}` };
	}
	return undefined;
}

export function compileSemanticAction(
	action: SemanticActionV1,
	bindings: Map<string, AgentCandidateBinding>,
): CompiledSemanticAction | CompileError {
	if (!isPublishedWriteKind(action.kind)) {
		return {
			code: "ACTION_UNSUPPORTED_SURFACE",
			message: `semantic action ${action.kind} is not published on agent-preview v1`,
		};
	}

	const resolverId = resolverIdForKind(action.kind);

	if (action.kind === "navigate") {
		const url = typeof action.url === "string" ? action.url.trim() : "";
		if (!url) {
			return { code: "INVALID_AGENT_REQUEST", message: "navigate requires a non-empty url" };
		}
		return {
			actionKind: action.kind,
			physical: false,
			targetBindings: [],
			execution: {
				kind: "navigation",
				plan: { type: "navigate", url, disposition: action.disposition ?? "current" },
			},
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: { kind: action.kind, resourceRefs: [], frames: 0 },
		};
	}

	if (action.kind === "history") {
		const direction = action.direction;
		if (direction !== "back" && direction !== "forward" && direction !== "reload") {
			return { code: "INVALID_AGENT_REQUEST", message: "history requires direction back|forward|reload" };
		}
		return {
			actionKind: action.kind,
			physical: false,
			targetBindings: [],
			execution: {
				kind: "navigation",
				plan: { type: "history", direction },
			},
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: { kind: action.kind, resourceRefs: [], frames: 0 },
		};
	}

	if (action.kind === "activate") {
		if (typeof action.ref !== "string" || !action.ref.trim()) {
			return { code: "INVALID_AGENT_REQUEST", message: "activate requires a candidate ref" };
		}
		const binding = requireBinding(action.ref, bindings);
		if (isCompileError(binding)) return binding;
		if (!binding.allowedActions.includes("activate")) {
			return { code: "ACTION_NOT_ALLOWED", message: `activate not allowed on ${action.ref}` };
		}
		const program = clickProgram(binding.resourceRef);
		const invalid = assertProgramValid(program);
		if (invalid) return invalid;
		return {
			actionKind: action.kind,
			physical: true,
			targetBindings: [binding],
			execution: { kind: "program", program },
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: { kind: action.kind, resourceRefs: [binding.resourceRef], frames: program.length },
		};
	}

	if (action.kind === "fill") {
		const binding = requireBinding(action.ref, bindings);
		if (isCompileError(binding)) return binding;
		if (!binding.allowedActions.includes("fill")) {
			return { code: "ACTION_NOT_ALLOWED", message: `fill not allowed on ${action.ref}` };
		}
		if (typeof action.value !== "string") {
			return { code: "INVALID_AGENT_REQUEST", message: "fill requires a string value" };
		}
		const program: TrustedProgramPrimitive[] = [
			...clickProgram(binding.resourceRef),
			...(action.replace === false ? [] : selectAllProgram()),
			{ text: action.value },
		];
		const invalid = assertProgramValid(program);
		if (invalid) return invalid;
		return {
			actionKind: action.kind,
			physical: true,
			targetBindings: [binding],
			execution: { kind: "program", program },
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: { kind: action.kind, resourceRefs: [binding.resourceRef], frames: program.length },
		};
	}

	if (action.kind === "press") {
		if (typeof action.key !== "string" || !action.key.trim()) {
			return { code: "INVALID_AGENT_REQUEST", message: "press requires a non-empty key" };
		}
		const binding = action.ref ? requireBinding(action.ref, bindings) : undefined;
		if (binding && isCompileError(binding)) return binding;
		if (binding && !binding.allowedActions.includes("press")) {
			return { code: "ACTION_NOT_ALLOWED", message: `press not allowed on ${action.ref}` };
		}
		const code = toKeyboardEventCode(action.key);
		const modifiers = mapModifiers(action.modifiers);
		const program: TrustedProgramPrimitive[] = [
			...(binding ? clickProgram(binding.resourceRef) : []),
			{ key: "down", code, ...(modifiers ? { modifiers } : {}) },
			{ key: "up", code, ...(modifiers ? { modifiers } : {}) },
		];
		const invalid = assertProgramValid(program);
		if (invalid) return invalid;
		return {
			actionKind: action.kind,
			physical: true,
			targetBindings: binding ? [binding] : [],
			execution: { kind: "program", program },
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: {
				kind: action.kind,
				resourceRefs: binding ? [binding.resourceRef] : [],
				frames: program.length,
			},
		};
	}

	if (action.kind === "scroll") {
		const direction = action.direction;
		if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
			return { code: "INVALID_AGENT_REQUEST", message: "scroll requires direction up|down|left|right" };
		}
		const binding = action.ref ? requireBinding(action.ref, bindings) : undefined;
		if (binding && isCompileError(binding)) return binding;
		if (binding && !binding.allowedActions.includes("scroll")) {
			return { code: "ACTION_NOT_ALLOWED", message: `scroll not allowed on ${action.ref}` };
		}
		const amount = action.amount === "page" ? 600 : 200;
		const delta = direction === "up" || direction === "left" ? -amount : amount;
		const horizontal = direction === "left" || direction === "right";
		const program: TrustedProgramPrimitive[] = [
			{
				mouse: "wheel",
				...(binding ? { ref: binding.resourceRef } : { x: 0, y: 0 }),
				...(horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta }),
			},
		];
		const invalid = assertProgramValid(program);
		if (invalid) return invalid;
		return {
			actionKind: action.kind,
			physical: true,
			targetBindings: binding ? [binding] : [],
			execution: { kind: "program", program },
			completionResolverId: resolverId,
			safety: { requiresConfirmation: false },
			debugPlan: {
				kind: action.kind,
				resourceRefs: binding ? [binding.resourceRef] : [],
				frames: program.length,
			},
		};
	}

	return {
		code: "ACTION_UNSUPPORTED_SURFACE",
		message: `unsupported action ${action.kind}`,
	};
}
