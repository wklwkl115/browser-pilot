const list = (value) => (Array.isArray(value) ? value : []);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined);
export const TASK_NEED_ORACLE = "record-edit-readiness/v1";

/** Fixture expectations supply the truth. The canonical model only binds exact selectors to opaque refs. */
export function bindTaskNeed(observation, contract) {
	if (
		!contract?.id ||
		!contract.record ||
		!contract.subject ||
		!contract.submit ||
		!Array.isArray(contract.descriptions) ||
		!Array.isArray(contract.candidates) ||
		!Array.isArray(contract.blockers)
	)
		throw new Error("An explicit fixture-owned observation need is required");
	if (
		![contract.record, contract.subject, contract.submit, ...contract.candidates].every(
			(item) => typeof item.name === "string" && item.name.length,
		) ||
		typeof contract.subject.value !== "string" ||
		!record(contract.subject.state) ||
		!record(contract.submit.state) ||
		![contract.subject, contract.submit].every(
			(item) => typeof item.state?.disabled === "boolean" && typeof item.state?.occluded === "boolean",
		) ||
		![...contract.descriptions, ...contract.blockers].every(
			(item) => typeof item.text === "string" && item.text.length,
		) ||
		!contract.candidates.some((item) => item.selector === contract.record.selector)
	)
		throw new Error(
			"Fixture needs must explicitly declare labels, current value, control state and candidate scope",
		);
	const pending = [...list(observation.entities)];
	const seen = new Set();
	const entities = [];
	for (let i = 0; i < pending.length; i++) {
		const entity = pending[i];
		if (!entity?.ref || seen.has(entity.ref)) continue;
		seen.add(entity.ref);
		entities.push(entity);
		pending.push(...list(entity.children));
	}
	const bind = (expected) => {
		if (!expected?.selector) throw new Error("Fixture evidence must declare an exact selector");
		const matches = entities.filter(
			(entity) =>
				(entity.hints?.targetId ??
					list(entity.locators).find((locator) => locator.by === "backendNodeId")?.targetId) ===
					expected.targetId &&
				(!expected.role || entity.role === expected.role) &&
				(entity.hints?.selector === expected.selector ||
					list(entity.locators).some(
						(locator) => locator.by === "css" && locator.value === expected.selector,
					)),
		);
		return { ...expected, ref: matches.length === 1 ? matches[0].ref : undefined };
	};
	return {
		id: contract.id,
		snapshotId: observation.snapshot.snapshotId,
		record: bind(contract.record),
		subject: bind(contract.subject),
		submit: bind(contract.submit),
		descriptions: contract.descriptions.map(bind),
		candidates: contract.candidates.map(bind),
		blockers: contract.blockers.map(bind),
	};
}

function deliveredEvidence(observations, snapshotId) {
	const facts = new Map();
	const edges = new Set();
	let wrongSnapshot = false;
	let hiddenAmbiguity = false;
	const claims = [];
	const addFact = (fact) => {
		if (typeof fact?.ref !== "string") return;
		const prior = facts.get(fact.ref) ?? [];
		prior.push(fact);
		facts.set(fact.ref, prior);
	};
	const edge = (from, relation, to) => {
		if (typeof from === "string" && typeof to === "string") edges.add(JSON.stringify([from, relation, to]));
	};
	const visit = (value) => {
		if (!record(value)) return;
		if (
			(value.snapshotId && value.snapshotId !== snapshotId) ||
			(value.scope?.snapshotId && value.scope.snapshotId !== snapshotId)
		) {
			wrongSnapshot = true;
			return;
		}
		if (record(value.task)) claims.push(value.task);
		const actionItems =
			value.actionSpace?.items ?? (record(value.coverage) && Array.isArray(value.scopes) ? value.items : []);
		for (const item of [...list(value.facts), ...list(value.entities), ...list(actionItems)]) {
			addFact(item);
			if (item.structuralParentRef) edge(item.ref, "containedBy", item.structuralParentRef);
			for (const relation of list(item.relations))
				if (relation.type !== "formOwner" || relation.source === "dom")
					edge(item.ref, relation.type, relation.targetRef);
		}
		for (const relation of list(value.relationEvidence)) {
			if (relation.snapshotId !== snapshotId) {
				wrongSnapshot = true;
				continue;
			}
			if (relation.relation !== "formOwner" || relation.basis === "native-association")
				edge(relation.fromRef, relation.relation, relation.toRef);
		}
		for (const relation of list(value.relations?.highlights ?? (record(value.summary) ? value.highlights : [])))
			edge(relation.sourceRef, relation.type, relation.targetRef);
		for (const item of list(value.outline)) addFact({ ref: item.container, name: item.name });
		if (value.anchor && !value.anchorNameTruncated) addFact(value.anchor);
		for (const child of [...list(value.bundles), ...list(value.packets), ...list(value.groups)]) visit(child);
		visit(value.bundle);
		visit(value.packet);
		visit(value.value);
	};
	for (const observation of observations) visit(observation);
	const candidatesDisclosed = (count) => {
		hiddenAmbiguity = claims.some(
			(claim) =>
				(count > 1 && claim.status === "resolved") ||
				claim.status === "no-match-in-observed" ||
				(typeof claim.matchScope?.candidateCount === "number" && claim.matchScope.candidateCount < count),
		);
		return !hiddenAmbiguity;
	};
	return { facts, edges, wrongSnapshot, candidatesDisclosed };
}

/** No requirement report, gap status, packet completeness flag, or projection ranking is an oracle. */
export function assessTaskNeed(need, observations) {
	const delivered = deliveredEvidence(observations, need.snapshotId);
	const matches = (expected, check) => !!expected.ref && (delivered.facts.get(expected.ref) ?? []).some(check);
	const consistent = (expected, key, value) =>
		!!expected.ref &&
		(delivered.facts.get(expected.ref) ?? []).every((fact) => fact[key] === undefined || fact[key] === value);
	const named = (expected) => matches(expected, (fact) => text(fact.name) === text(expected.name));
	const related = (from, type, to) => !!from && !!to && delivered.edges.has(JSON.stringify([from, type, to]));
	const ownedSubject = () => {
		const pending = [need.subject.ref];
		const seen = new Set();
		for (let i = 0; i < pending.length; i++) {
			const ref = pending[i];
			if (!ref || seen.has(ref)) continue;
			seen.add(ref);
			if (ref === need.record.ref || related(ref, "formOwner", need.record.ref)) return true;
			for (const encoded of delivered.edges) {
				const [from, type, to] = JSON.parse(encoded);
				if (from === ref && ["containedBy", "rowOf"].includes(type)) pending.push(to);
			}
		}
		return false;
	};
	const state = (expected) =>
		matches(expected, (fact) =>
			Object.entries(expected.state).every(([key, value]) => fact.state?.[key] === value),
		) &&
		(delivered.facts.get(expected.ref) ?? []).every((fact) =>
			Object.entries(expected.state).every(
				([key, value]) => fact.state?.[key] === undefined || fact.state[key] === value,
			),
		);
	const checks = {
		"record-identity": named(need.record),
		"subject-identity": named(need.subject) && matches(need.subject, (fact) => list(fact.actions).includes("edit")),
		"subject-value":
			matches(need.subject, (fact) => fact.value === need.subject.value) &&
			consistent(need.subject, "value", need.subject.value),
		"subject-ownership": ownedSubject(),
		"related-descriptions": need.descriptions.every(
			(expected) =>
				matches(
					expected,
					(fact) => text(fact.text) === text(expected.text) || text(fact.name) === text(expected.text),
				) && related(need.subject.ref, "describedBy", expected.ref),
		),
		"submit-identity": named(need.submit) && matches(need.submit, (fact) => list(fact.actions).includes("click")),
		"submit-ownership": related(need.submit.ref, "formOwner", need.record.ref),
		"known-control-state": state(need.subject) && state(need.submit),
		"candidate-disclosure": need.candidates.every(named) && delivered.candidatesDisclosed(need.candidates.length),
		"blocking-evidence": need.blockers.every((expected) =>
			matches(
				expected,
				(fact) =>
					fact.state?.visible === true &&
					(text(fact.text) === text(expected.text) || text(fact.name) === text(expected.text)),
			),
		),
		"snapshot-consistency": !delivered.wrongSnapshot,
	};
	const missing = Object.entries(checks)
		.filter(([, satisfied]) => !satisfied)
		.map(([id]) => id);
	return { satisfied: missing.length === 0, checks, missing };
}
