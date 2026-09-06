import type { Entity } from "../../src/kernels/abml/entity.ts";
import { taskEntity, taskObservation } from "./taskView.ts";

export function taskEvidenceScenario(
	options: {
		wrapped?: boolean;
		external?: boolean;
		otherRecord?: boolean;
		ownership?: "proven" | "removed" | "conflicting";
		missingDescription?: boolean;
	} = {},
) {
	const owner = taskEntity("invariant-owner", "form", "INV-2048");
	owner.hints = { selector: "#invoice" };
	const identity = taskEntity("invariant-id", "heading", "INV-2048");
	identity.hints = { contextParentRef: owner.ref };
	const note = taskEntity("invariant-note", "textbox", "Note");
	note.value = "Draft";
	const save = taskEntity("invariant-save", "button", "Save");
	const description = taskEntity("invariant-description", "paragraph", "Review this invoice before saving.");
	const entities: Entity[] = [owner, identity, note, save];
	note.hints = { contextParentRef: owner.ref };
	save.hints = { contextParentRef: owner.ref, formOwnerObserved: true, formOwnerSelector: "#invoice" };
	note.relations = [{ type: "describedBy", targetRef: description.ref, source: "ax", confidence: "high" }];
	save.relations =
		options.ownership === "removed"
			? []
			: [
					{
						type: "formOwner",
						targetRef: owner.ref,
						source: "dom",
						confidence: "high",
						evidence: { basis: "native-association" },
					},
				];
	if (options.wrapped) {
		const wrapper = taskEntity("invariant-wrapper", "group", "Fields");
		wrapper.hints = { contextParentRef: owner.ref };
		note.hints.contextParentRef = wrapper.ref;
		entities.push(wrapper);
	}
	if (options.external) delete save.hints.contextParentRef;
	if (!options.missingDescription) entities.push(description);
	if (options.otherRecord || options.ownership === "conflicting") {
		const other = taskEntity("invariant-other", "form", "INV-2099");
		other.hints = { selector: "#other" };
		const otherSave = taskEntity("invariant-other-save", "button", "Save");
		otherSave.hints = { contextParentRef: other.ref };
		entities.push(other, otherSave);
		if (options.ownership === "conflicting")
			save.relations.push({
				type: "formOwner",
				targetRef: other.ref,
				source: "dom",
				confidence: "high",
				evidence: { basis: "native-association" },
			});
	}
	const observation = taskObservation(entities);
	observation.snapshot.capturedAt = 1000;
	const spec = { focus: { refs: [note.ref] }, intent: "interact" as const, fields: ["Note"] };
	return { owner, identity, note, save, description, entities, observation, spec };
}
