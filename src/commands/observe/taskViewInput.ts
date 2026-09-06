import { Type } from "typebox";
import { Value } from "typebox/value";
import type { NormalizedTaskViewSpec, TaskViewSpec } from "../../kernels/abml/taskView.js";
import { BrowserBridgeError } from "../../utils/errors.js";
import { resolveExecutionRef, type ExecutionRefTarget } from "../../browser-command-runtime/executionRef.js";
import { resolveRefExecutionTarget } from "../commandRuntime.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { ObserveToolParams } from "./common.js";
import type { PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { pageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageIdentityFromUnknown } from "./pageIdentity.js";

const nonBlank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
export const taskViewInputSchema = Type.Object(
	{
		focus: Type.Union([
			Type.Object(
				{
					refs: Type.Array(Type.String({ pattern: "^bp-ref://", maxLength: 512 }), {
						minItems: 1,
						maxItems: 8,
					}),
				},
				{ additionalProperties: false },
			),
			Type.Object({ query: nonBlank(256) }, { additionalProperties: false }),
		]),
		intent: Type.Optional(Type.Enum(["locate", "read", "interact", "check"])),
		fields: Type.Optional(Type.Array(nonBlank(64), { maxItems: 16 })),
	},
	{ additionalProperties: false },
);
export const observeViewSchema = Type.Union([Type.Literal("page"), taskViewInputSchema], {
	description:
		"Optional declarative information need: explicit refs or a literal query, intent and preferred field labels. Organizes captured evidence only; never authorizes actions or proves business success. Omit for the whole-page view.",
});

export function prepareTaskView(value: unknown): NormalizedTaskViewSpec | undefined {
	if (value === undefined || value === "page") return undefined;
	if (!Value.Check(taskViewInputSchema, value))
		throw new BrowserBridgeError(
			"INVALID_RULE",
			"view requires refs or a non-blank literal query, optional intent and field labels",
		);
	const spec = value as TaskViewSpec;
	return {
		focus: "refs" in spec.focus ? { refs: [...new Set(spec.focus.refs)] } : { query: spec.focus.query.trim() },
		intent: spec.intent ?? "read",
		fields: [...new Set((spec.fields ?? []).map((field) => field.trim()))],
	};
}

export function prepareTaskViewTarget(server: BrowserCommandRuntimePort, params: ObserveToolParams): ObserveToolParams {
	const spec = params.view;
	if (!spec || !("refs" in spec.focus)) return params;
	const anchors = spec.focus.refs.map((ref) => resolveExecutionRef(ref).target);
	if (anchors.some((anchor) => !["element", "control", "text", "region", "media", "frame"].includes(anchor.kind)))
		throw new BrowserBridgeError("INVALID_RULE", "Task focus requires page object refs");
	// Observation checks identity and ownership but does not require write permission.
	const target = resolveRefExecutionTarget(server, [], {
		observedRefs: anchors,
		browserSessionId: params.browserSessionId,
		rawTarget: params.targetRef,
	});
	return {
		...params,
		browserSessionId: target.browserSessionId,
		targetRef: params.targetRef ?? String(target.tabId),
		taskAnchors: anchors,
	};
}

export function validateTaskAnchorSnapshot(
	anchors: ExecutionRefTarget[] | undefined,
	observation: PageObservationV3,
): void {
	if (!anchors?.length) return;
	const identity = pageIdentityFromUnknown(observation.snapshot);
	for (const anchor of anchors) {
		const reason = pageReanchorReason(anchor.pageIdentity, identity);
		if (reason)
			throw new BrowserBridgeError("REF_STALE", "Task focus page changed during observation; locate again", {
				ref: anchor.refId,
				reason,
			});
	}
}
