import { PerceptionLedger } from "../../kernels/abml/perceptionLedger.js";
import { SessionKernel } from "../../kernels/session/index.js";
import { BrowserTemporalCoordinator } from "./BrowserTemporalCoordinator.js";
import { isOpen } from "./bridgeUtils.js";
import type { WebSocket } from "ws";

export class BrowserBridgeSessionState extends SessionKernel<WebSocket> {
	readonly perceptionLedger = new PerceptionLedger();
	readonly temporal = new BrowserTemporalCoordinator();

	constructor() {
		super({ isOpenClient: isOpen });
	}

	clear(): void {
		super.clear();
		this.perceptionLedger.clear();
	}
}
