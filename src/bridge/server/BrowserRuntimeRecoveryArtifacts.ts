import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../utils/records.js";
import type { BrowserBridgeClientInfo, BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo } from "./types.js";

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

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_PENDING_WRITES = 16;

function artifactRoot(cwd = process.cwd()): string {
	return path.resolve(cwd, ".browser-pilot", "artifacts", "runtime-recovery");
}

function jsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function boundedJsonLine(event: Record<string, unknown>): string {
	const line = jsonLine(event);
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes <= MAX_EVENT_BYTES) return line;
	const summary: Record<string, unknown> = { omitted: true, omittedBytes: bytes };
	for (const key of ["type", "ts", "domain", "command", "action", "method", "browserSessionId", "tabId", "browserId", "extensionId"]) {
		if (event[key] !== undefined) summary[key] = event[key];
	}
	return jsonLine(summary);
}

async function appendRotating(outputPath: string, line: string): Promise<void> {
	const size = (await stat(outputPath).catch(() => undefined))?.size ?? 0;
	if (size > 0 && size + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES) {
		const rotatedPath = `${outputPath}.1`;
		await rm(rotatedPath, { force: true });
		await rename(outputPath, rotatedPath);
	}
	await appendFile(outputPath, line, "utf8");
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
	private pendingWrites = 0;
	private droppedEvents = 0;

	constructor(cwd = process.cwd()) {
		this.cwd = cwd;
	}

	private enqueue(fileName: string, event: Record<string, unknown>): void {
		if (this.pendingWrites >= MAX_PENDING_WRITES) {
			this.droppedEvents += 1;
			return;
		}
		const payload = this.droppedEvents > 0 ? { ...event, droppedEvents: this.droppedEvents } : event;
		let line: string;
		try {
			line = boundedJsonLine(payload);
		} catch {
			this.droppedEvents += 1;
			return;
		}
		this.droppedEvents = 0;
		this.pendingWrites += 1;
		const root = artifactRoot(this.cwd);
		const outputPath = path.join(root, fileName);
		this.tail = this.tail
			.then(async () => {
				await mkdir(root, { recursive: true });
				await appendRotating(outputPath, line);
			})
			.catch(() => {})
			.finally(() => { this.pendingWrites -= 1; });
	}

	async flush(): Promise<void> {
		await this.tail;
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
