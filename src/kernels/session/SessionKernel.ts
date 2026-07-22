import { SessionLeaseRegistry } from "./leaseRegistry.js";
import { SessionObservationSnapshotRegistry } from "./observationSnapshotRegistry.js";
import { SessionRegistry } from "./sessionRegistry.js";

export class SessionKernel<TClient = unknown> {
	readonly browserSessions: SessionRegistry<TClient>;
	readonly leases: SessionLeaseRegistry;
	readonly observationSnapshots: SessionObservationSnapshotRegistry;

	constructor(options: { isOpenClient?: (client: TClient) => boolean } = {}) {
		this.browserSessions = new SessionRegistry<TClient>({ isOpenClient: options.isOpenClient });
		this.leases = new SessionLeaseRegistry();
		this.observationSnapshots = new SessionObservationSnapshotRegistry();
	}

	clear(): void {
		this.browserSessions.clear();
		this.leases.clear();
		this.observationSnapshots.clear();
	}
}
