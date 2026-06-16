export type ObserveRelevanceSourceTag = "A" | "B" | "C" | "D" | "E" | "F";

export type ObserveRelevanceTapKind = "literal" | "selectorLiteral" | "jsonPath" | "query" | "urlPathToken" | "urlQueryToken" | "ref" | "intent";

export type ObserveRelevanceTerm = {
	term: string;
	kind: ObserveRelevanceTapKind;
	weight?: number;
	source: ObserveRelevanceSourceTag;
	age?: number;
};

export type ObserveRelevanceInput = {
	ref: string;
	fields?: {
		name?: string;
		role?: string;
		container?: string;
		landmark?: string;
		value?: string;
		selector?: string;
		href?: string;
	};
	neighbors?: {
		containerKey?: string;
		labelledBySources?: string[];
	};
};

type ObserveRelevanceMatch = {
	score: number;
	sources: ObserveRelevanceSourceTag[];
};

export type ObserveRelevanceResult = {
	byRef: Map<string, ObserveRelevanceMatch>;
	boosted: number;
	signals: ObserveRelevanceSourceTag[];
	scoreFields: (fields: Record<string, unknown>) => number;
};
