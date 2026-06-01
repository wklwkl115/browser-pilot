import { readBrowserMemoryResource } from "../src/tools/memory/reader.js";
import { isMemoryResourceFresh, resolveMemoryResourceUri } from "./memoryResourceStore.js";

export async function readMemoryResource(uri: string, cwd?: string) {
	const resource = await resolveMemoryResourceUri(uri, cwd);
	if (!resource) return { ok: false as const, error: `Resource not found: ${uri}`, code: "RESOURCE_NOT_FOUND" };
	if (!isMemoryResourceFresh(resource)) return { ok: false as const, error: `Resource is stale: ${uri}`, code: "MEMORY_RESOURCE_STALE" };
	return await readBrowserMemoryResource(uri, cwd);
}
