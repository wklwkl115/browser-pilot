import { SessionLeaseRegistry } from "./leaseRegistry.js";
import { SessionObservationSnapshotRegistry } from "./observationSnapshotRegistry.js";
import { SessionOperationRegistry } from "./operationRegistry.js";
import { SessionRegistry } from "./sessionRegistry.js";

export class SessionKernel<TClient = unknown> {
	readonly browserSessions: SessionRegistry<TClient>;
	readonly leases: SessionLeaseRegistry;
	readonly operations: SessionOperationRegistry;
	readonly observationSnapshots: SessionObservationSnapshotRegistry;

	constructor(options: { isOpenClient?: (client: TClient) => boolean } = {}) {
		this.browserSessions = new SessionRegistry<TClient>({ isOpenClient: options.isOpenClient });
		this.leases = new SessionLeaseRegistry();
		this.operations = new SessionOperationRegistry();
		this.observationSnapshots = new SessionObservationSnapshotRegistry();
	}

	clear(): void {
		this.browserSessions.clear();
		this.leases.clear();
		this.operations.clear();
		this.observationSnapshots.clear();
	}
}
