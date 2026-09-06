export async function checkOwnerContextVariants(ctx) {
	await ctx.call("browser_execute", {
		script: `const save = document.querySelector('#target-save');
const actions = document.createElement('div'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Action controls');
save.after(actions); actions.append(save);
document.body.insertAdjacentHTML('beforeend', '<table role="table"><tbody><tr role="row" aria-label="Invoice row"><td role="cell">LINE-3051</td><td role="cell"><div role="group" aria-label="Row fields"><label>Row note <input id="row-note" value="Draft row"></label></div></td><td role="cell"><button>Apply row</button></td></tr><tr role="row" aria-label="Other row"><td role="cell">LINE-3052</td><td role="cell"><input aria-label="Other row note"></td><td role="cell"><button>Apply other row</button></td></tr></tbody></table>');`,
	});
	const record = await ctx.observe({ view: { focus: { query: "INV-2048" }, intent: "interact" } });
	const note = record.bundles
		.flatMap((bundle) => bundle.facts)
		.find((fact) => fact.name === "Note" && fact.actions?.includes("edit"));
	ctx.assert(!!note, "NESTED_FIELD", "Missing nested invoice field");
	const focused = await ctx.observe({ view: { focus: { refs: [note.ref] }, intent: "interact" } });
	const candidate = focused.bundles.find((bundle) => bundle.candidate);
	ctx.assert(
		candidate.gaps.includes("context-identity-unknown") &&
			candidate.gaps.includes("context-actions-unknown") &&
			!focused.task.outputScope.contextComplete,
		"UNCERTAIN_GROUP_CONTEXT",
		"A sibling action group was silently omitted without an ownership gap",
	);
	const resource = focused.frontier.items.find((item) => item.ref === "frontier:task-view");
	const index = await ctx.readResource(resource.resourceUri);
	const expanded = await ctx.readResource(index.groups.find((group) => group.candidate).resourceUri);
	ctx.assert(
		expanded.bundle.gaps.includes("context-actions-unknown"),
		"HISTORICAL_CONTEXT_GAP",
		"Expanded task resource lost its context uncertainty",
	);
	const row = await ctx.observe({ view: { focus: { query: "LINE-3051" }, intent: "interact" } });
	const rowNote = row.bundles
		.flatMap((bundle) => bundle.facts)
		.find((fact) => fact.name === "Row note" && fact.actions?.includes("edit"));
	ctx.assert(!!rowNote, "ROW_FIELD", "Missing row field");
	const rowFocus = await ctx.observe({ view: { focus: { refs: [rowNote.ref] }, intent: "interact" } });
	const fields = rowFocus.bundles.filter((bundle) => bundle.candidate).flatMap((bundle) => bundle.facts);
	ctx.assert(
		fields.some((fact) => fact.name === "LINE-3051") && fields.some((fact) => fact.name === "Apply row"),
		"ROW_IDENTITY_CONTEXT",
		"Ordinary cells lost the row identity or its action",
	);
	ctx.assert(
		!fields.some((fact) => fact.name === "LINE-3052" || fact.name === "Apply other row"),
		"SIBLING_ROW_ISOLATION",
		"A neighboring row leaked into task context",
	);
}

export async function checkExactTargetDuringRouteChange(ctx) {
	const destination = `${ctx.fixture.url}task-view/saved`;
	const other = `${ctx.fixture.url}task-view/other`;
	const result = await ctx.call("browser_execute", {
		script: `history.replaceState(null, '', ${JSON.stringify(destination)});
const proof = document.createElement('p'); proof.id = 'scope-proof'; proof.textContent = 'Saved'; document.body.append(proof);
window.scopeOrigin = performance.timeOrigin; window.scopeRouteChanges = 0;
const query = document.querySelectorAll;
document.querySelectorAll = function(selector) {
 if (selector === '#scope-proof') {
  document.querySelectorAll = query;
  history.replaceState(null, '', ${JSON.stringify(other)});
  window.scopeRouteChanges++;
 }
 return query.call(this, selector);
};`,
		business: {
			success: {
				allOf: [
					{ url: { equals: destination } },
					{ text: { selector: "#scope-proof", match: { equals: "Saved" } } },
				],
			},
		},
		verificationWaitMs: 100,
	});
	ctx.assert(
		result.business.status === "unknown",
		"EXACT_TARGET_SCOPE",
		"Original document identity bypassed the declared destination URL",
	);
	const conditions = result.business.success?.observed.conditions;
	ctx.assert(
		conditions?.[0]?.status === "verified" && conditions?.[1]?.status === "inconclusive",
		"URL_READ_PRECEDED_ROUTE_CHANGE",
		"The URL must match before the DOM read changes the route; an earlier mismatch would not exercise the regression",
	);
	ctx.assert(
		await ctx.read(
			`window.scopeRouteChanges === 1 && window.scopeOrigin === performance.timeOrigin && location.href === ${JSON.stringify(other)}`,
		),
		"SAME_DOCUMENT_ROUTE_FIXTURE",
		"The controlled same-document route change did not occur during the DOM condition read",
	);
}
