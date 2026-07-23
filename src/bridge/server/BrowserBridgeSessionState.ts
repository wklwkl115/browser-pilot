import { PerceptionLedger } from "../../kernels/session/perceptionLedger.js";
import { SessionObservationSnapshotRegistry } from "../../kernels/session/observationSnapshotRegistry.js";
import { SessionRegistry } from "../../kernels/session/sessionRegistry.js";
import { isOpen } from "./bridgeUtils.js";
import type { WebSocket } from "ws";

export class BrowserBridgeSessionState {
	readonly browserSessions = new SessionRegistry<WebSocket>({ isOpenClient: isOpen });
	readonly observationSnapshots = new SessionObservationSnapshotRegistry();
	readonly perceptionLedger = new PerceptionLedger();

	clear(): void {
		this.browserSessions.clear();
		this.observationSnapshots.clear();
		this.perceptionLedger.clear();
	}
}
