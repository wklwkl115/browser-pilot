import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo } from "./types";

type RuntimeRecoveryBridgeInfo = {
	runtimeRecovery?: unknown;
	workerBootId?: unknown;
	workerStartedAt?: unknown;
	bridgePort?: unknown;
	primaryPort?: unknown;
	id?: unknown;
	name?: unknown;
	version?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function artifactRoot(cwd = process.cwd()): string {
	return path.resolve(cwd, ".pi", "browser-artifacts", "runtime-recovery");
}

function jsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function domainForCommand(command: unknown): "network" | "intercept" | null {
	if (!isRecord(command) || typeof command.cmd !== "string") return null;
	if (command.cmd.startsWith("network.")) return "network";
	if (command.cmd.startsWith("intercept.")) return "intercept";
	return null;
}

export class BrowserRuntimeRecoveryArtifacts {
	private tail: Promise<void> = Promise.resolve();
	private readonly cwd: string;

	constructor(cwd = process.cwd()) {
		this.cwd = cwd;
	}

	private enqueue(fileName: string, event: Record<string, unknown>): void {
		const root = artifactRoot(this.cwd);
		const outputPath = path.join(root, fileName);
		this.tail = this.tail
			.then(async () => {
				await mkdir(root, { recursive: true });
				await appendFile(outputPath, jsonLine(event), "utf8");
			})
			.catch(() => {});
	}

	recordRuntimeRecovery(client: BrowserBridgeClientInfo | undefined, bridge: RuntimeRecoveryBridgeInfo | undefined): void {
		const runtimeRecovery = isRecord(bridge?.runtimeRecovery) ? bridge.runtimeRecovery : undefined;
		if (!runtimeRecovery) return;
		this.enqueue("runtime-recovery.jsonl", {
			type: "runtimeRecovery",
			ts: Date.now(),
			browserId: client?.id,
			extensionId: client?.extensionId,
			workerBootId: bridge?.workerBootId,
			workerStartedAt: bridge?.workerStartedAt,
			bridgePort: bridge?.bridgePort,
			primaryPort: bridge?.primaryPort,
			bridge: {
				id: bridge?.id,
				name: bridge?.name,
				version: bridge?.version,
			},
			runtimeRecovery,
		});
	}

	recordCommandResult(command: unknown, result: BrowserBridgeExecutionResult, options: { browserSessionId?: string; target?: BrowserBridgeTargetInfo; snapshot: BrowserBridgeSnapshot }): void {
		const domain = domainForCommand(command);
		if (!domain || !isRecord(command)) return;
		const data = isRecord(result.data) ? result.data : undefined;
		this.enqueue(`${domain}-events.jsonl`, {
			type: `${domain}CommandResult`,
			ts: Date.now(),
			domain,
			command: command.cmd,
			action: command.action,
			method: command.method,
			browserSessionId: options.browserSessionId,
			tabId: result.tabId,
			target: options.target,
			workerBootId: options.snapshot.extension?.workerBootId,
			generation: data?.generation,
			recoveredAt: data?.recoveredAt,
			historyLost: data?.historyLost,
			pausedLost: data?.pausedLost,
			stateLost: data?.stateLost,
			lostSession: data?.lostSession,
			result: result.data,
		});
	}
}
