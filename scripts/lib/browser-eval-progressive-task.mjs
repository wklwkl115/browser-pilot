export const progressiveEvaluationTask = {
	id: "task-view-progressive",
	suite: "extended",
	kind: "workflow",
	path: "task-progressive",
	async run(ctx) {
		const view = await ctx.observe({
			view: { focus: { query: "INV-7777" }, intent: "interact", fields: ["Note"] },
		});
		await ctx.compareTaskViews();
		const resource = view.frontier.items.find((item) => item.ref === "frontier:task-view");
		const index = await ctx.readResource(resource.resourceUri);
		const descriptor = index.packetIndex.packets.find((packet) => packet.question === "Note context");
		ctx.assert(
			!!descriptor,
			"PACKET_DISCOVERY",
			"The field beyond a large group needs an independent packet resource",
		);
		const expanded = await ctx.readResource(descriptor.resourceUri);
		const packet = expanded.packet;
		const note = packet.facts.find((fact) => fact.name === "Note" && fact.actions?.includes("edit"));
		const save = packet.facts.find((fact) => fact.name === "Save packet" && fact.actions?.includes("click"));
		const complete =
			packet.scope.contextComplete &&
			!!note &&
			!!save &&
			packet.facts.some((fact) => fact.name === "INV-7777") &&
			packet.facts.some((fact) => fact.name === "Note requires review" || fact.text === "Note requires review");
		ctx.recoverableGap(complete);
		ctx.assert(
			complete,
			"PACKET_DEPENDENCIES",
			"Captured evidence should yield complete independent editing context",
		);
		ctx.assert(
			packet.relationEvidence.some(
				(edge) =>
					edge.fromRef === save.ref && edge.relation === "formOwner" && edge.basis === "native-association",
			),
			"NATIVE_FORM_PROOF",
			"The external Save needs native association evidence",
		);
		ctx.assert(
			!packet.facts.some((fact) => fact.value === "Other draft" || fact.name === "INV-8888"),
			"PACKET_ISOLATION",
			"Another form leaked into the packet",
		);
		ctx.beginTaskEffects();
		await ctx.input(note.ref, "type", { text: "Reviewed packet", clear: true });
		ctx.verified(
			await ctx.input(
				save.ref,
				"click",
				{},
				"window.packetSaves === 1 && window.packetSavedValue === 'Reviewed packet' && window.otherPacketSaves === 0",
			),
		);
		const historical = await ctx.readResource(descriptor.resourceUri);
		ctx.assert(
			historical.packet.facts.some((fact) => fact.ref === note.ref && fact.value === "Draft packet"),
			"PACKET_HISTORY",
			"Old packet changed after the write",
		);
		ctx.assert(
			JSON.stringify(historical) === JSON.stringify(expanded),
			"PACKET_REPEAT_READ",
			"Repeated reads changed saved evidence",
		);
	},
};
