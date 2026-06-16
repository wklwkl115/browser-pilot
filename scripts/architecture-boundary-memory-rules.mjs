import { memoryCommandLeakRules } from "./architecture-boundary-memory-command-rules.mjs";
import { memoryFacadeLeakRules } from "./architecture-boundary-memory-facade-rules.mjs";
import { perceptionLedgerLeakRules } from "./architecture-boundary-perception-ledger-rules.mjs";

export const memoryLeakRules = [
	...memoryCommandLeakRules,
	...perceptionLedgerLeakRules,
	...memoryFacadeLeakRules,
];
