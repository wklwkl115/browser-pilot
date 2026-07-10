import { PerceptionLedger } from "../../kernels/session/perceptionLedger.js";
import { createIntentRefRegistry, type IntentRefRegistry } from "../../kernels/session/intentRefRegistry.js";

// Bridge-local re-export so the bridge-server main file can annotate its accessor without importing
// the session kernel directly (architecture boundary: bridge-server-main-to-kernels).
export type { IntentRefRegistry } from "../../kernels/session/intentRefRegistry.js";
import { SessionKernel } from "../../kernels/session/SessionKernel.js";
import { BrowserTemporalCoordinator } from "./BrowserTemporalCoordinator.js";
import { isOpen } from "./bridgeUtils.js";
import type { WebSocket } from "ws";

export class BrowserBridgeSessionState extends SessionKernel<WebSocket> {
	readonly perceptionLedger = new PerceptionLedger();
	readonly intentRefRegistry: IntentRefRegistry = createIntentRefRegistry();
	readonly temporal = new BrowserTemporalCoordinator();

	constructor() {
		super({ isOpenClient: isOpen });
	}

	clear(): void {
		super.clear();
		this.perceptionLedger.clear();
	}
}
