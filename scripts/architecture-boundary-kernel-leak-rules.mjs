import { evidenceLeakRules } from "./architecture-boundary-evidence-rules.mjs";
import { memoryLeakRules } from "./architecture-boundary-memory-rules.mjs";
import { runtimeLeakRules } from "./architecture-boundary-runtime-rules.mjs";
import { securityLeakRules } from "./architecture-boundary-security-rules.mjs";

export const kernelLeakRules = [
	...runtimeLeakRules,
	...memoryLeakRules,
	...evidenceLeakRules,
	...securityLeakRules,
];
