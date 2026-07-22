export function urlOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}
