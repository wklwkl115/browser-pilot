export type FrontierRetrieve = {
	tool: "browser_artifact";
	mode: "json";
	jsonPath?: string;
	offset?: number;
	limit?: number;
};

export type DistillFrontier = {
	dropped: {
		count: number;
		kinds: string[];
		fields?: string[];
		items?: number;
		nextOffset?: number | null;
	};
	retrieve: FrontierRetrieve;
};

export function artifactJsonRetrieve(input: { jsonPath?: string; offset?: number; limit?: number }): FrontierRetrieve {
	return {
		tool: "browser_artifact",
		mode: "json",
		...(input.jsonPath && input.jsonPath !== "$" ? { jsonPath: input.jsonPath } : {}),
		...(input.offset !== undefined ? { offset: input.offset } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
	};
}

export function buildProjectionFrontier(input: { jsonPath?: string; offset: number; limit: number; droppedFields?: string[]; droppedItems?: number; foldedKinds?: string[]; nextOffset?: number | null }): DistillFrontier {
	const fields = input.droppedFields ?? [];
	const itemCount = Math.max(0, Math.floor(input.droppedItems ?? 0));
	const kinds = Array.from(new Set([...(input.foldedKinds ?? []), ...(fields.length ? ["variantFields"] : []), ...(itemCount ? ["items"] : [])]));
	return {
		dropped: {
			count: fields.length + itemCount,
			kinds,
			...(fields.length ? { fields } : {}),
			...(itemCount ? { items: itemCount } : {}),
			...(input.nextOffset !== undefined ? { nextOffset: input.nextOffset } : {}),
		},
		retrieve: artifactJsonRetrieve({ jsonPath: input.jsonPath, offset: input.offset, limit: input.limit }),
	};
}
