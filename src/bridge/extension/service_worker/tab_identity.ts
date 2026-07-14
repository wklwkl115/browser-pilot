import { chromeApi as chrome } from "./runtimeEnv";
import type { BrowserPilotChromeTab, JsonRecord } from "./types";

const TAB_IDENTITIES_STORAGE_KEY = "browserPilotTabIdentitiesV1";
const TAB_IDENTITY_PATTERN = /^[a-f0-9]{32}$/;

let cachedTabIdentities: Record<string, string> | undefined;
let tabIdentitiesLoad: Promise<Record<string, string>> | undefined;

function normalizedTabId(value: unknown): number | undefined {
	const tabId = Number(value);
	return Number.isInteger(tabId) && tabId > 0 ? tabId : undefined;
}

function normalizedStoredIdentities(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const identities: Record<string, string> = {};
	for (const [key, identity] of Object.entries(value as JsonRecord)) {
		if (/^\d+$/.test(key) && typeof identity === "string" && TAB_IDENTITY_PATTERN.test(identity)) identities[key] = identity;
	}
	return identities;
}

async function loadBrowserPilotTabIdentities(): Promise<Record<string, string>> {
	if (cachedTabIdentities) return cachedTabIdentities;
	if (tabIdentitiesLoad) return await tabIdentitiesLoad;
	tabIdentitiesLoad = (async () => {
		const session = chrome.storage?.session;
		if (!session?.get) return {};
		try {
			const stored = await session.get(TAB_IDENTITIES_STORAGE_KEY);
			return normalizedStoredIdentities(stored[TAB_IDENTITIES_STORAGE_KEY]);
		} catch {
			return {};
		}
	})();
	cachedTabIdentities = await tabIdentitiesLoad;
	tabIdentitiesLoad = undefined;
	return cachedTabIdentities;
}

async function persistBrowserPilotTabIdentities(identities: Record<string, string>): Promise<void> {
	const session = chrome.storage?.session;
	if (!session?.set) return;
	try {
		await session.set({ [TAB_IDENTITIES_STORAGE_KEY]: { ...identities } });
	} catch {
		/* In-memory identity still preserves the current service-worker lifetime. */
	}
}

function newBrowserPilotTabIdentity(): string {
	return (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/[^a-fA-F0-9]/g, "").toLowerCase().padEnd(32, "0").slice(0, 32);
}

async function ensureBrowserPilotTabIdentity(tabIdValue: unknown): Promise<string | undefined> {
	const tabId = normalizedTabId(tabIdValue);
	if (tabId === undefined) return undefined;
	const identities = await loadBrowserPilotTabIdentities();
	const key = String(tabId);
	if (identities[key]) return identities[key];
	const identity = newBrowserPilotTabIdentity();
	identities[key] = identity;
	await persistBrowserPilotTabIdentities(identities);
	return identity;
}

async function browserPilotTabIdentityFields(tab: BrowserPilotChromeTab): Promise<{ tabIdentity?: string }> {
	const tabIdentity = await ensureBrowserPilotTabIdentity(tab.id);
	return tabIdentity ? { tabIdentity } : {};
}

async function forgetBrowserPilotTabIdentity(tabIdValue: unknown): Promise<void> {
	const tabId = normalizedTabId(tabIdValue);
	if (tabId === undefined) return;
	const identities = await loadBrowserPilotTabIdentities();
	if (!identities[String(tabId)]) return;
	delete identities[String(tabId)];
	await persistBrowserPilotTabIdentities(identities);
}

async function replaceBrowserPilotTabIdentity(removedTabIdValue: unknown, addedTabIdValue: unknown): Promise<string | undefined> {
	const removedTabId = normalizedTabId(removedTabIdValue);
	const addedTabId = normalizedTabId(addedTabIdValue);
	if (addedTabId === undefined) return undefined;
	const identities = await loadBrowserPilotTabIdentities();
	const removedKey = removedTabId === undefined ? undefined : String(removedTabId);
	const addedKey = String(addedTabId);
	const identity = (removedKey ? identities[removedKey] : undefined) ?? identities[addedKey] ?? newBrowserPilotTabIdentity();
	if (removedKey && removedKey !== addedKey) delete identities[removedKey];
	identities[addedKey] = identity;
	await persistBrowserPilotTabIdentities(identities);
	return identity;
}

function resetBrowserPilotTabIdentitiesForTest(): void {
	cachedTabIdentities = undefined;
	tabIdentitiesLoad = undefined;
}

export { browserPilotTabIdentityFields, ensureBrowserPilotTabIdentity, forgetBrowserPilotTabIdentity, replaceBrowserPilotTabIdentity, resetBrowserPilotTabIdentitiesForTest };
