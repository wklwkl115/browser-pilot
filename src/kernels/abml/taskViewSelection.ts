import type { Entity } from "./entity.js";
import type { PageObservationV3 } from "./pageObservation.js";
import {
	normalizeTaskText,
	type DecisionBundle,
	type NormalizedTaskViewSpec,
	type TaskFact,
	type TaskMatch,
	type TaskProjectionPlan,
} from "./taskView.js";
import { taskContext, taskEntityIndex, taskObjectRoot, type TaskEntityIndex } from "./taskViewGraph.js";

const MAX_GROUPS = 256;
const MAX_FACT_TEXT = 8192;
const GLOBAL_ROLES = new Set(["dialog", "alertdialog", "alert", "status"]);

function password(entity: Entity): boolean {
	return entity.hints?.inputKind === "password" || entity.role.toLowerCase().includes("password");
}

function entityMatches(entity: Entity, query: string): TaskMatch[] {
	const values: Array<[TaskMatch["field"], unknown]> = [
		["name", entity.name],
		["label", entity.hints?.placeholder],
	];
	values.push(["content", entity.hints?.contextText]);
	if (!password(entity)) values.push(["value", entity.value]);
	return values.flatMap(([field, value]) => {
		if (typeof value !== "string") return [];
		const normalized = normalizeTaskText(value);
		return normalized.includes(query)
			? [
					{
						ref: entity.ref,
						field,
						text: value,
						kind: normalized === query ? ("exact" as const) : ("contains" as const),
					},
				]
			: [];
	});
}

function fact(entity: Entity, allowActions: boolean, gaps: Set<string>): TaskFact {
	const copyText = (value: string | undefined) => {
		if (value === undefined) return undefined;
		if (value.length > MAX_FACT_TEXT) gaps.add("fact-text-exceeds-selection-limit");
		return value.slice(0, MAX_FACT_TEXT);
	};
	const name = copyText(entity.name);
	const value = password(entity) ? undefined : copyText(entity.value);
	const text = typeof entity.hints?.contextText === "string" ? copyText(entity.hints.contextText) : undefined;
	if (entity.hints?.contextTextIncomplete === true) gaps.add("captured-context-text-incomplete");
	const state = entity.state;
	return {
		ref: entity.ref,
		role: entity.role,
		source: entity.source,
		...(name !== undefined ? { name } : {}),
		...(value !== undefined ? { value } : {}),
		...(text ? { text, textSource: "ax" } : {}),
		state: {
			visible: state.visible,
			occluded: state.occluded,
			disabled: state.disabled,
			focused: state.focused,
			editable: state.editable,
			inViewport: state.inViewport,
			...(state.checked !== undefined ? { checked: state.checked } : {}),
			...(state.selected !== undefined ? { selected: state.selected } : {}),
			...(state.pressed !== undefined ? { pressed: state.pressed } : {}),
			...(state.expanded !== undefined ? { expanded: state.expanded } : {}),
			...(state.current !== undefined ? { current: state.current } : {}),
		},
		...(allowActions && entity.actionability ? { actions: [...entity.actionability.actions] } : {}),
	};
}

type Candidate = { anchor: Entity; matches: TaskMatch[]; explicit: boolean };

function candidates(
	index: TaskEntityIndex,
	spec: NormalizedTaskViewSpec,
): { candidates: Candidate[]; unresolved: string[] } {
	if ("refs" in spec.focus) {
		const refs = spec.focus.refs;
		return {
			candidates: refs.flatMap((ref) => {
				const anchor = index.byRef.get(ref);
				return anchor ? [{ anchor, matches: [], explicit: true }] : [];
			}),
			unresolved: refs.filter((ref) => !index.byRef.has(ref)),
		};
	}
	const query = normalizeTaskText(spec.focus.query);
	const grouped = new Map<string, Candidate>();
	for (const entity of index.entities) {
		const matches = entityMatches(entity, query);
		if (!matches.length) continue;
		const anchor = taskObjectRoot(index, entity);
		const candidate = grouped.get(anchor.ref) ?? { anchor, matches: [], explicit: false };
		candidate.matches.push(...matches);
		grouped.set(anchor.ref, candidate);
	}
	return {
		candidates: [...grouped.values()].sort(
			(a, b) =>
				Number(b.matches.some((match) => match.kind === "exact")) -
				Number(a.matches.some((match) => match.kind === "exact")),
		),
		unresolved: [],
	};
}

function bundleKind(entity: Entity): DecisionBundle["kind"] {
	const role = entity.role.toLowerCase();
	if (role === "dialog" || role === "alertdialog") return "dialog";
	if (role === "alert" || role === "status") return "feedback";
	if (entity.state.editable) return "field";
	if (["row", "listitem", "article", "form", "group", "region"].includes(role)) return "record";
	return "context";
}

function buildBundle(
	index: TaskEntityIndex,
	candidate: Candidate,
	spec: NormalizedTaskViewSpec,
	observation: PageObservationV3,
): DecisionBundle {
	const { anchor } = candidate;
	const context = taskContext(index, anchor, {
		spec,
		matchedRefs: new Set(candidate.matches.flatMap((match) => (match.ref ? [match.ref] : []))),
		changedRefs: new Set((observation.diff?.changed ?? []).map((change) => change.ref)),
	});
	const gaps = new Set(context.gaps);
	if (candidate.explicit || candidate.matches.length) {
		for (const field of spec.fields)
			if (
				!context.entities.some((entity) =>
					normalizeTaskText(entity.name ?? "").includes(normalizeTaskText(field)),
				)
			)
				gaps.add(`preferred-field-not-observed: ${field}`);
	}
	const role = anchor.role.toLowerCase();
	const mandatory = GLOBAL_ROLES.has(role) && anchor.state.visible;
	const selected = context.entities;
	const facts = selected.map((entity) =>
		fact(entity, !gaps.has("object-context-unavailable") || candidate.explicit, gaps),
	);
	const members = new Set(selected.map((entity) => entity.ref));
	const changes = (observation.diff?.changed ?? [])
		.filter((change) => members.has(change.ref))
		.map((change) => ({
			ref: change.ref,
			kind: change.kind,
			fields: Object.keys(change.after ?? change.before ?? {}),
		}));
	for (const ref of observation.diff?.appeared ?? [])
		if (members.has(ref)) changes.push({ ref, kind: "appeared", fields: [] });
	return {
		id: "",
		kind: bundleKind(anchor),
		anchor: {
			ref: anchor.ref,
			role: anchor.role,
			...(anchor.name ? { name: anchor.name.slice(0, MAX_FACT_TEXT) } : {}),
		},
		candidate: candidate.explicit || candidate.matches.length > 0,
		mandatory,
		reasons: [
			mandatory
				? "observed-global-signal"
				: candidate.explicit
					? "explicit-focus"
					: role === "navigation"
						? "global-navigation"
						: "literal-match",
		],
		facts,
		matches: candidate.matches
			.slice(0, 128)
			.map((match) => ({ ...match, text: match.text.slice(0, MAX_FACT_TEXT) })),
		gaps: [...gaps, ...(candidate.matches.length > 128 ? ["match-evidence-limit"] : [])],
		changes,
	};
}

function contentEvidence(
	observation: PageObservationV3,
	spec: NormalizedTaskViewSpec,
): { count: number; bundle?: DecisionBundle } {
	if (!("query" in spec.focus) || !observation.content) return { count: 0 };
	const text = observation.content.text;
	const query = normalizeTaskText(spec.focus.query);
	const normalized = normalizeTaskText(text);
	const first = normalized.indexOf(query);
	if (first < 0) return { count: 0 };
	let count = 0;
	for (let at = first; at >= 0; at = normalized.indexOf(query, at + query.length)) count++;
	// This excerpt is explicitly whitespace/case-normalized, not a verbatim DOM substring.
	const excerpt = normalized.slice(Math.max(0, first - 160), Math.min(normalized.length, first + query.length + 320));
	return {
		count,
		bundle: {
			id: "",
			kind: "content",
			anchor: { name: "Captured text match" },
			candidate: false,
			mandatory: false,
			reasons: ["normalized-literal-content-match"],
			facts: [],
			matches: [{ field: "content", text: excerpt, kind: normalized === query ? "exact" : "contains" }],
			text: excerpt,
			gaps: ["text-match-does-not-establish-object-ownership"],
			changes: [],
		},
	};
}

/** Pure selection over the complete captured model, before generic projection or byte budgeting. */
export function projectTaskView(observation: PageObservationV3, spec: NormalizedTaskViewSpec): TaskProjectionPlan {
	const index = taskEntityIndex(observation.entities ?? []);
	const selected = candidates(index, spec);
	const content = contentEvidence(observation, spec);
	const byAnchor = new Map(selected.candidates.map((candidate) => [candidate.anchor.ref, candidate]));
	const global = index.entities.filter(
		(entity) => entity.state.visible && GLOBAL_ROLES.has(entity.role.toLowerCase()),
	);
	const globalRefs = new Set(global.map((entity) => entity.ref));
	const navigation = index.entities.filter(
		(entity) => entity.state.visible && entity.role.toLowerCase() === "navigation" && !byAnchor.has(entity.ref),
	);
	const ordered = [
		...global.map((anchor) => byAnchor.get(anchor.ref) ?? { anchor, matches: [], explicit: false }),
		...selected.candidates.filter((candidate) => !globalRefs.has(candidate.anchor.ref)),
		...navigation.map((anchor) => ({ anchor, matches: [], explicit: false })),
	];
	const bundles = ordered.slice(0, MAX_GROUPS).map((candidate) => buildBundle(index, candidate, spec, observation));
	if (content.bundle && selected.candidates.length === 0) bundles.push(content.bundle);
	bundles.forEach((bundle, i) => {
		bundle.id = `task-group-${i + 1}`;
	});
	const complete = index.complete && ordered.length <= MAX_GROUPS;
	const inputAvailable =
		observation.entities !== undefined &&
		(index.entities.length > 0 ||
			observation.content?.complete === true ||
			observation.actionSpace?.coverage.captureComplete === true);
	const collections = taskCollections(observation, bundles);
	const partial = collections.filter((collection) => collection.completeness !== "complete").length;
	const count = selected.candidates.length;
	const status =
		!complete || !inputAvailable || selected.unresolved.length
			? "unresolved"
			: count > 1
				? "ambiguous"
				: count === 1
					? "resolved"
					: content.count || !observation.entities
						? "unresolved"
						: "no-match-in-observed";
	const limitations = ["Only captured evidence was searched; unloaded pages were not checked."];
	if (!complete) limitations.push("Task selection reached an internal bound; candidates or context may be missing.");
	if (spec.intent === "check")
		limitations.push(
			"Current UI evidence is not a business receipt; query browser_operation for an operation's outcome.",
		);
	if (!observation.diff)
		limitations.push("No comparable page-change baseline is available; current facts are self-contained.");
	if (observation.reanchorReason) limitations.push(`Page context was re-anchored: ${observation.reanchorReason}.`);
	for (const [name, provider] of Object.entries(observation.providers))
		if (provider.status === "failed" || provider.status === "degraded")
			limitations.push(`Capture provider ${name}: ${provider.status}.`);
	return {
		task: {
			intent: spec.intent,
			focus: spec.focus,
			fields: [...spec.fields],
			status,
			unresolvedRefs: selected.unresolved,
			observationScope: {
				entitiesObserved: index.entities.length,
				contentComplete: observation.content?.complete === true,
				actionsComplete: observation.actionSpace?.coverage.captureComplete === true,
				selectionComplete: complete,
				collectionCount: collections.length,
				partialCollectionCount: partial,
				collections,
			},
			matchScope: {
				method: "refs" in spec.focus ? "explicit-refs" : "literal-case-insensitive",
				unit: "structural-object-or-entity",
				candidateCount: count,
				contentMatchCount: content.count,
				searched:
					"refs" in spec.focus
						? ["explicit-refs"]
						: ["name", "non-password-value", "placeholder", "captured-content"],
				complete: index.complete && inputAvailable,
			},
			outputScope: {
				groupsTotal: ordered.length + (content.bundle && selected.candidates.length === 0 ? 1 : 0),
				groupsInline: bundles.length,
				groupsFolded: Math.max(0, ordered.length - MAX_GROUPS),
				mandatoryGroups: global.length,
				mandatoryGroupsFolded: global.length - bundles.filter((bundle) => bundle.mandatory).length,
				contextComplete:
					complete && !selected.unresolved.length && capturedContextComplete(observation, bundles),
			},
			limitations,
		},
		bundles,
	};
}

function capturedContextComplete(observation: PageObservationV3, bundles: DecisionBundle[]): boolean {
	return (
		observation.actionSpace?.coverage.captureComplete === true &&
		observation.content?.complete === true &&
		bundles.every((bundle) => bundle.gaps.length === 0)
	);
}

function taskCollections(observation: PageObservationV3, bundles: DecisionBundle[]) {
	const selected = new Set(
		bundles.filter((bundle) => bundle.candidate).flatMap((bundle) => bundle.facts.map((fact) => fact.ref)),
	);
	return (observation.collections ?? [])
		.map((collection) => ({
			collection,
			relevant: selected.has(collection.ref) || collection.itemRefs.some((ref) => selected.has(ref)),
		}))
		.sort((a, b) => Number(b.relevant) - Number(a.relevant))
		.map(({ collection: { ref, name, observed, total, completeness } }) => ({
			ref,
			...(name ? { name } : {}),
			observed,
			...(total !== undefined ? { total } : {}),
			completeness,
		}));
}
