import {
	buildMemoryRoutingIndex as kernelBuildMemoryRoutingIndex,
	memoryRoutingTokens as kernelMemoryRoutingTokens,
	routeByTokens as kernelRouteByTokens,
	situationTokens as kernelSituationTokens,
} from "../kernels/memory/routing.js";

export type MemoryRoutingIndex = Record<string, string[]>;
export type MemoryRoutingEntry = { id: string; status: string; title: string; triggers: string[] };
export type MemoryRoutingParts = { title: string; triggers: string[] };

export function memoryRoutingTokens(parts: MemoryRoutingParts): string[] {
	return kernelMemoryRoutingTokens(parts);
}

export function situationTokens(text: string): string[] {
	return kernelSituationTokens(text);
}

export function buildMemoryRoutingIndex(entries: MemoryRoutingEntry[]): MemoryRoutingIndex {
	return kernelBuildMemoryRoutingIndex(entries);
}

export function routeByTokens(routing: MemoryRoutingIndex | undefined, tokens: string[]): Map<string, number> {
	return kernelRouteByTokens(routing, tokens);
}
