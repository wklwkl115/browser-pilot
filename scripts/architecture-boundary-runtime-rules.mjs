import { refLeakRules } from "./architecture-boundary-ref-leak-rules.mjs";
import { runtimePortLeakRules } from "./architecture-boundary-runtime-port-rules.mjs";
import { temporalLeakRules } from "./architecture-boundary-temporal-leak-rules.mjs";

export const runtimeLeakRules = [
	...runtimePortLeakRules,
	...refLeakRules,
	...temporalLeakRules,
];
