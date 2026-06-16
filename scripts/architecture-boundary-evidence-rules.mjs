import { evidenceDistillerLeakRules } from "./architecture-boundary-evidence-distiller-rules.mjs";
import { evidenceFactLeakRules } from "./architecture-boundary-evidence-fact-rules.mjs";
import { evidenceRelevanceLeakRules } from "./architecture-boundary-evidence-relevance-rules.mjs";
import { evidenceResultLeakRules } from "./architecture-boundary-evidence-result-rules.mjs";

export const evidenceLeakRules = [
	...evidenceFactLeakRules,
	...evidenceRelevanceLeakRules,
	...evidenceResultLeakRules,
	...evidenceDistillerLeakRules,
];
