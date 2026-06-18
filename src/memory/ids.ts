export function normalizeMemoryEntryId(value: unknown): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 96);
	return normalized || `memory-${Date.now()}`;
}
