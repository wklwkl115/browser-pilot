export type BrowserRuntimeCommand = {
	cmd: string;
	[key: string]: unknown;
};

export interface BrowserRuntimePort {
	send(command: BrowserRuntimeCommand, options?: { timeoutMs?: number; sessionId?: string }): Promise<unknown>;
	status(): Promise<unknown>;
}
