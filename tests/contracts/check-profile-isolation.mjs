import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserOrchestrationCoordinator, normalizeDesired } from "../../src/driver/orchestration/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function resolveReadPath(rel) {
	const wslPath = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(rel);
	if (wslPath && process.platform === "win32") return `${wslPath[1].toUpperCase()}:\\${wslPath[2].replace(/\//g, "\\")}`;
	if (path.isAbsolute(rel)) return rel;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(rel);
	if (drivePath) return process.platform === "win32" ? rel : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, rel);
}
const read = (rel) => readFileSync(resolveReadPath(rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

function profileDesired(profileId = "profile-runtime-a") {
	return {
		apiVersion: "pi.browser/v1",
		orchestrationId: `orch-${profileId}`,
		isolation: { scope: "profile", profile: { profileId, lifecycle: "managed", reuse: "owned", cleanup: "delete" } },
		sessions: [{ tag: "p", tabs: [{ role: "main", url: "https://example.test/profile", waitUntil: "none" }], cookies: [{ name: "sid", value: `secret-${profileId}`, path: "/" }] }],
	};
}

class ProfileRuntimeFixture {
	constructor() {
		this.clients = [];
		this.profiles = new Map();
		this.tabs = [];
		this.cookies = new Map();
		this.nextTabId = 100;
		this.selected = undefined;
		this.stoppedProfiles = [];
	}
	snapshot() { return { host: "127.0.0.1", port: 1, running: true, connectedClients: this.clients.length, extensionConnected: !!this.selected, extension: this.selected, clients: this.clients, defaultTabId: this.tabs[0]?.tabId, latestTabId: this.tabs.at(-1)?.tabId, selectionVersion: 1, tabs: this.getTabs({ includeDisconnected: true }), profiles: Array.from(this.profiles.values()), pending: [] }; }
	getTabs() { return structuredClone(this.tabs); }
	async refreshTabs() { return this.getTabs(); }
	selectBrowser(browserId) { const client = this.clients.find((item) => item.id === browserId || item.extensionId === browserId); if (!client) throw new Error(`unknown browser ${browserId}`); this.selected = client; return client; }
	async ensureManagedProfile({ profileId, cleanup = "delete" }) {
		let profile = this.profiles.get(profileId);
		if (profile) { this.selectBrowser(profile.browserId); return profile; }
		const client = { id: `browser-${profileId}`, extensionId: `ext-${profileId}`, name: "Fake Managed Profile", profileId, managedProfile: { profileId, bridgePort: 18800 + this.clients.length, owned: true, cleanup }, connectedAt: Date.now(), lastSeenAt: Date.now() };
		this.clients.push(client);
		this.selected = client;
		profile = { profileId, bridgePort: client.managedProfile.bridgePort, debugPort: 9300 + this.clients.length, browserId: client.id, browserExtensionId: client.extensionId, processId: 4000 + this.clients.length, owned: true, cleanup };
		this.profiles.set(profileId, profile);
		return profile;
	}
	async stopManagedProfile(profileId) { const profile = this.profiles.get(profileId); if (!profile) return undefined; this.stoppedProfiles.push(profileId); this.profiles.delete(profileId); this.clients = this.clients.filter((item) => item.profileId !== profileId); this.tabs = this.tabs.filter((item) => item.profileId !== profileId); if (this.selected?.profileId === profileId) this.selected = this.clients[0]; return profile; }
	async createTab(url, active = true) { const client = this.selected; if (!client) throw new Error("no selected profile client"); const tab = { id: `${client.id}:${++this.nextTabId}`, browserId: client.id, browserExtensionId: client.extensionId, tabId: this.nextTabId, url, title: "", active, windowId: 1, profileId: client.profileId, type: "ext_ws", connectedAt: Date.now(), bridge: client }; this.tabs.push(tab); return { id: `create-${tab.tabId}`, acknowledged: true, tabId: tab.tabId, data: { tabId: tab.tabId, id: tab.tabId, url, windowId: 1 }, newTabs: [{ tabId: tab.tabId, id: tab.tabId, url, windowId: 1 }] }; }
	async closeTab(tabId) { this.tabs = this.tabs.filter((item) => item.tabId !== Number(tabId)); return { id: `close-${tabId}`, acknowledged: true, data: { ok: true, closed: true } }; }
	cookieKey(command) { return `${this.selected?.profileId || "default"}\n${command.url}\n${command.name}`; }
	async sendCommand(command, options = {}) {
		if (command.cmd === "cookies") {
			const key = this.cookieKey(command);
			if (command.method === "set") { this.cookies.set(key, String(command.value ?? "")); return { id: "cookie-set", acknowledged: true, data: { set: true } }; }
			if (command.method === "get") return { id: "cookie-get", acknowledged: true, data: this.cookies.has(key) ? { name: command.name, value: this.cookies.get(key), url: command.url } : null };
			if (command.method === "remove") return { id: "cookie-remove", acknowledged: true, data: { removed: this.cookies.delete(key) } };
		}
		if (command.cmd === "wait.loadState" || command.cmd === "wait.networkIdle") return { id: "wait", acknowledged: true, tabId: Number(options.tabId), data: { ok: true, state: command.state || "networkidle" } };
		if (command.cmd === "tabs" && command.method === "create") return this.createTab(command.url || "about:blank", command.active !== false);
		if (command.cmd === "tabs" && command.method === "close") return this.closeTab(command.targetTabId || command.tabId);
		return { id: "ok", acknowledged: true, tabId: Number(options.tabId || 0) || undefined, data: { ok: true } };
	}
}

const doc = read("docs/browser-profile-isolation.md");
for (const required of [
	"TODO233 runtime 已实现",
	"BrowserProfileManager.ts",
	"--user-data-dir",
	"--disable-extensions-except",
	"--load-extension",
	"独立 bridge port",
	"driver-owned browser process",
	"scope?: \"logical\" | \"browser\" | \"profile\"",
	"profileId",
	"cookie/localStorage/sessionStorage",
	"local_redacted_profile_isolation",
	"Incognito opt-in diagnostic",
	"INCOGNITO_NOT_ALLOWED",
	"不进入默认 gate",
]) assert(doc.includes(required), `profile isolation doc missing required term: ${required}`);

const normalized = normalizeDesired(profileDesired());
assert.equal(normalized.isolation.scope, "profile", "profile scope must be accepted at runtime");
assert.deepEqual(normalized.isolation.profile, { profileId: "profile-runtime-a", lifecycle: "managed", reuse: "owned", cleanup: "delete" }, "profile isolation metadata must normalize");
assert.throws(() => normalizeDesired({ ...profileDesired(), isolation: { scope: "profile" } }), /isolation\.profile is required/, "profile scope requires isolation.profile");
assert.throws(() => normalizeDesired({ ...profileDesired(), isolation: { scope: "profile", profile: { profileId: "p", lifecycle: "user" } } }), /lifecycle must be managed/, "profile lifecycle must remain managed-only");
assert.throws(() => normalizeDesired({ ...profileDesired(), isolation: { scope: "profile", profile: { profileId: "p", lifecycle: "managed", reuse: "matchingUrl" } } }), /reuse must be none or owned/, "profile reuse must be bounded");
assert.throws(() => normalizeDesired({ ...profileDesired(), isolation: { scope: "profile", profile: { profileId: "p", lifecycle: "managed", cleanup: "keep" } } }), /cleanup must be delete or keepOnFailure/, "profile cleanup policy must be bounded");

const fixture = new ProfileRuntimeFixture();
const coordinator = new BrowserOrchestrationCoordinator(fixture, { persistence: false });
const desired = profileDesired("profile-runtime-contract");
const plan = await coordinator.plan(desired, { timeoutMs: 5_000 });
assert(plan.plan.operations.some((operation) => operation.action === "ensureProfile"), "profile plan must ensure a managed profile before tab/cookie operations");
const apply = await coordinator.apply(desired, { timeoutMs: 5_000 });
assert.equal(apply.ok, true, "profile apply fixture must converge");
assert(apply.operationResults.some((item) => item.action === "ensureProfile" && item.status === "succeeded"), "profile apply must execute ensureProfile");
assert(apply.bindings.some((binding) => binding.profileId === "profile-runtime-contract" && binding.browserId === "browser-profile-runtime-contract"), "profile apply must persist profile-bound binding");
const status = await coordinator.status("orch-profile-runtime-contract", { timeoutMs: 5_000 });
assert.equal(status.converged, true, "profile status must converge after apply");
const deleted = await coordinator.delete("orch-profile-runtime-contract", { timeoutMs: 5_000 });
assert.equal(deleted.ok, true, "profile delete must cleanup fixture resources");
assert(deleted.operationResults.some((item) => item.action === "stopProfile" && item.status === "succeeded"), "profile delete must stop the owned managed profile");
assert.deepEqual(fixture.stoppedProfiles, ["profile-runtime-contract"], "delete must stop only the owned profile id");

const manifest = json("bridge/pi_browser_bridge/manifest.json");
assert.equal(Object.hasOwn(manifest, "incognito"), false, "manifest must not configure default incognito mode");
assert.equal(JSON.stringify(manifest).includes("incognito"), false, "manifest must not add incognito as a default capability");

const profileManager = read("src/driver/BrowserProfileManager.ts");
for (const required of ["class BrowserProfileManager", "ensureProfile", "stopProfile", "--user-data-dir", "--disable-extensions-except", "--load-extension", "PI_BROWSER_MANAGED_PROFILE_B64", "taskkill.exe", "removePathWithRetry"]) assert(profileManager.includes(required), `BrowserProfileManager missing runtime primitive ${required}`);
const bridgeServer = read("src/driver/BrowserBridgeServer.ts");
for (const required of ["BrowserProfileManager", "ensureManagedProfile", "stopManagedProfile", "managedProfiles", "profiles: this.profileManager.list()", "startBridgeEndpoint"]) assert(bridgeServer.includes(required), `BrowserBridgeServer missing profile wiring ${required}`);
const clientRegistry = read("src/driver/BrowserBridgeClientRegistry.ts");
assert(clientRegistry.includes("managedProfile") && clientRegistry.includes("profileId"), "client registry must ingest managed profile metadata from bridge_info");
const targetResolver = read("src/driver/BrowserTargetResolver.ts");
assert(targetResolver.includes("profileFiltered") && targetResolver.includes("No orchestration binding matches target profileId") && targetResolver.includes("liveSessionForTabTarget(resolved.binding.tabId, resolved.binding.browserId, resolved.binding.profileId)"), "target resolver must enforce profile-bound binding disambiguation");
const tabRouter = read("src/driver/BrowserTabSessionRouter.ts");
assert(tabRouter.includes("profileId") && tabRouter.includes("liveSessionForTabTarget(tabId: number, browserId?: string, profileId?: string)"), "tab router must keep profileId on physical tab sessions");
const reconcile = read("src/driver/orchestration/ReconcileExecutor.ts");
for (const required of ["ensureProfile", "stopProfile", "selectProfileBrowser", "desired.isolation.profile?.profileId", "createdProfileIds", "cleanup managed profile after required operation failure"]) assert(reconcile.includes(required), `reconcile executor missing profile runtime wiring ${required}`);
const planner = read("src/driver/orchestration/DiffPlanner.ts");
assert(planner.includes('push("profile", "ensureProfile"') && planner.includes("managed profile is required for physical isolation"), "diff planner must plan managed profile creation");
const config = read("bridge_src/service_worker/config.ts");
const bridgeInfo = read("bridge_src/service_worker/bridge_info.ts");
assert(config.includes("PI_BROWSER_MANAGED_PROFILE_B64") && config.includes("PI_BROWSER_MANAGED_PROFILE"), "bridge config source must expose managed profile metadata placeholder");
assert(bridgeInfo.includes("profileId: PI_BROWSER_MANAGED_PROFILE?.profileId") && bridgeInfo.includes("managedProfile: PI_BROWSER_MANAGED_PROFILE"), "bridge_info must report managed profile identity");
const syncConfig = read("scripts/sync-bridge-config.mjs");
assert(syncConfig.includes("bridge_src") && syncConfig.includes("PI_BROWSER_MANAGED_PROFILE_B64") && !syncConfig.includes("pi_browser_bridge\", \"config.js"), "sync:config must preserve bridge_src managed profile placeholder");

const smoke = read("tests/smoke/smoke-browser.mjs");
for (const step of ["browser_orchestrate.profileIsolationPlan", "browser_orchestrate.profileIsolationApply", "browser_orchestrate.profileIsolationStorage", "browser_orchestrate.profileIsolationDeleteA", "browser_orchestrate.profileIsolationDelete", "browser_orchestrate.profileIsolationArtifact"]) assert(smoke.includes(step), `profile smoke missing step ${step}`);
assert(smoke.includes("profile-isolation-result.json") && smoke.includes("local_redacted_profile_isolation") && smoke.includes("forbiddenCookieAbsent") && smoke.includes("forbiddenLocalAbsent") && smoke.includes("forbiddenSessionAbsent"), "profile smoke must verify redacted cookie/localStorage/sessionStorage isolation artifact");
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
assert(isolatedSmoke.includes("profileIsolation") && isolatedSmoke.includes("profileIsolationApply") && isolatedSmoke.includes("profileIsolationStorage"), "isolated smoke diagnostics must surface profile isolation results");
const releaseAcceptance = read("tests/release/release-local-acceptance.mjs");
assert(releaseAcceptance.includes("profileIsolation"), "release smoke diagnostics must include profile isolation summary");
assert.equal(isolatedSmoke.includes("--incognito"), false, "isolated smoke default gate must not launch incognito");
assert.equal(/incognito/i.test(releaseAcceptance), false, "release acceptance default gate must not include incognito");

const targetDoc = read("docs/browser-target-resolver.md");
assert(targetDoc.includes("profileId") && targetDoc.includes("profile-bound orchestration target"), "target resolver doc must describe profileId runtime semantics");
const coordinatorDoc = read("docs/browser-orchestration-coordinator.md");
assert(coordinatorDoc.includes("TODO 233") && coordinatorDoc.includes("Managed Profile-first 实现 Gate") && coordinatorDoc.includes("isolation.scope:\"profile\""), "coordinator doc must mark profile runtime capability");
const roadmap = read("docs/browser-orchestration-next-roadmap.md");
assert(roadmap.includes("TODO233. Managed Profile-first 实现 Gate") && roadmap.includes("状态：已完成 runtime 实现与 smoke gate"), "roadmap must mark TODO233 complete");
const todo = read("TODO.md");
assert(todo.includes("## 233. Managed Profile-first 实现 Gate") && todo.includes("- [x] 目标：实现 owned browser profile lifecycle"), "TODO.md must mark TODO233 complete");
const readme = read("README.md");
assert(readme.includes("TODO 233 已实现 managed profile-first runtime") && readme.includes("profile A/B cookie/localStorage/sessionStorage"), "README must document managed profile runtime status");
const install = read("AI_INSTALL.md");
assert(install.includes("isolation.scope:\"profile\"") && install.includes("PI_BROWSER_PROFILE_CHROME"), "AI_INSTALL must document managed profile runtime and Chrome path env");
const skill = read("/mnt/d/Pi/agent/skills/pi-browser-tools/SKILL.md");
assert(skill.includes("isolation.scope:\"profile\"") && skill.includes("managed profile"), "global skill must describe explicit managed profile isolation");

const pkg = json("package.json");
assert(String(pkg.scripts?.["check:profile-isolation"] || "").includes("check-profile-isolation.mjs"), "package must expose check:profile-isolation");
assert(String(pkg.scripts?.check || "").includes("check:profile-isolation"), "npm run check must include profile isolation contract");

console.log("profile isolation contract ok");
