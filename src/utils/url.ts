export function urlOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

let cachedOriginUrl: string | undefined;
let cachedOrigin: string | undefined;
let hasCachedOrigin = false;

export function memoizedUrlOrigin(url: string | undefined): string | undefined {
	if (hasCachedOrigin && url === cachedOriginUrl) return cachedOrigin;
	cachedOriginUrl = url;
	cachedOrigin = urlOrigin(url);
	hasCachedOrigin = true;
	return cachedOrigin;
}
