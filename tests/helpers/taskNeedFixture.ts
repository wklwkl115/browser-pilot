import { taskEvidenceScenario } from "./taskEvidenceScenario.ts";

export function taskNeedFixture() {
	const f = taskEvidenceScenario();
	f.observation.snapshot.capturedAt = Date.now();
	f.note.hints!.selector = "#note";
	f.save.hints!.selector = "#save";
	f.description.hints = { selector: "#help" };
	f.note.relations!.push({
		type: "formOwner",
		targetRef: f.owner.ref,
		source: "dom",
		confidence: "high",
		evidence: { basis: "native-association" },
	});
	const contract = {
		id: "synthetic-invoice-note",
		record: { selector: "#invoice", role: "form", name: "INV-2048" },
		subject: {
			selector: "#note",
			role: "textbox",
			name: "Note",
			value: "Draft",
			state: { disabled: false, occluded: false },
		},
		submit: { selector: "#save", role: "button", name: "Save", state: { disabled: false, occluded: false } },
		descriptions: [{ selector: "#help", text: "Review this invoice before saving." }],
		candidates: [{ selector: "#invoice", role: "form", name: "INV-2048" }],
		blockers: [] as Array<{ selector: string; text: string }>,
	};
	const delivery = () => ({
		snapshotId: f.observation.snapshot.snapshotId,
		entities: f.entities.map((entity) => ({
			ref: entity.ref,
			role: entity.role,
			name: entity.name,
			value: entity.value,
			state: { ...entity.state },
			actions: entity.actionability?.actions,
			relations: (entity.relations ?? []).map((edge) => ({
				type: edge.type,
				targetRef: edge.targetRef,
				source: edge.source,
			})),
		})),
	});
	return { ...f, contract, delivery };
}
