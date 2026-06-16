import { PerceptionLedger } from "../../kernels/session/perceptionLedger.js";
import { createIntentRefRegistry, type IntentRefRegistry } from "../../kernels/session/intentRefRegistry.js";
import { SessionKernel } from "../../kernels/session/index.js";
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
