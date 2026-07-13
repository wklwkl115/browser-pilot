import { randomBytes } from "node:crypto";
import { AgentContextRegistry } from "../../kernels/session/agentContextRegistry.js";
import type { AgentContextPort } from "../../browser-runtime/ports/AgentContextPort.js";

/** Daemon-owned live mechanical context store. Commands receive the port, never import this class. */
export class AgentContextService extends AgentContextRegistry implements AgentContextPort {
	constructor() {
		super({
			newId: () => `ctx_${randomBytes(16).toString("hex")}`,
		});
	}
}

let activeService: AgentContextService | undefined;

export function installAgentContextService(service: AgentContextService): AgentContextPort {
	activeService = service;
	return service;
}

export function getAgentContextService(): AgentContextPort {
	if (!activeService) {
		activeService = new AgentContextService();
	}
	return activeService;
}

export function resetAgentContextServiceForTests(): void {
	activeService = undefined;
}
