export interface HttpClientPort {
	request(input: {
		method: string;
		url: string;
		headers?: Record<string, string>;
		body?: string | Uint8Array;
		timeoutMs?: number;
	}): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}
