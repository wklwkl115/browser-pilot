function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function compactTabForList(tab: Record<string, unknown>): Record<string, unknown> {
	const targetRef = firstString(tab.targetRef, tab.tabHandle);
	return {
		...(targetRef ? { targetRef } : {}),
		...(typeof tab.url === "string" ? { url: tab.url } : {}),
		...(typeof tab.title === "string" ? { title: tab.title } : {}),
		...(typeof tab.active === "boolean" ? { active: tab.active } : {}),
		...(typeof tab.incognito === "boolean" ? { incognito: tab.incognito } : {}),
	};
}
