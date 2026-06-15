export function normalizeMemoryEntryId(value: unknown): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 96);
	return normalized || `memory-${Date.now()}`;
}

export function newMemoryEntryId(prefix: string): string {
	const suffix = Math.random().toString(36).slice(2, 8);
	return normalizeMemoryEntryId(`${prefix}-${Date.now()}-${suffix}`);
}
