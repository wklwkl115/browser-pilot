import { BrowserBridgeError } from "./errors";
import { toTabId } from "./bridgeUtils";
import type { BrowserTabSessionRouter } from "./BrowserTabSessionRouter";
import type { OrchestrationStore } from "./orchestration/OrchestrationStore";
import type { BrowserBridgeTargetInfo, BrowserTabInfo, BrowserToolTargetRef, ResolveBrowserToolTargetInput } from "./types";

type NormalizedToolTarget = BrowserToolTargetRef & { tabId?: number; windowId?: number; groupId?: number };

type ResolveContext = { toolName?: string; commandName?: string };

const TARGET_FIELDS = new Set(["tabId", "browserId", "orchestrationId", "sessionTag", "tabRole", "windowId", "groupId", "profileId", "requireOwned"]);

function compactTarget(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => TARGET_FIELDS.has(key))) : undefined;
}

function normalizedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class BrowserTargetResolver {
	private readonly tabs: BrowserTabSessionRouter;
	private readonly store: OrchestrationStore;
	private readonly getTabs: () => BrowserTabInfo[];

	constructor(tabs: BrowserTabSessionRouter, store: OrchestrationStore, getTabs: () => BrowserTabInfo[]) {
		this.tabs = tabs;
		this.store = store;
		this.getTabs = getTabs;
	}

	resolve(input: ResolveBrowserToolTargetInput): BrowserBridgeTargetInfo | undefined {
		const commandName = input.commandName;
		const topLevelTabId = this.normalizeExplicitTabId(input.topLevelTabId, "options", commandName);
		const commandTabId = this.normalizeExplicitTabId(input.commandBody?.tabId, "command", commandName);
		const target = this.normalizeToolTarget(input.target, { allowEmpty: input.allowEmptyTarget === true, commandName });
		const targetTabId = this.normalizeExplicitTabId(target?.tabId, "target", commandName);
		this.assertSameTabId(topLevelTabId, targetTabId, { commandName, left: "tabId", right: "target.tabId", target });
		if (!target && topLevelTabId !== undefined && commandTabId !== undefined && topLevelTabId !== commandTabId) {
			throw new BrowserBridgeError("TAB_ID_CONFLICT", "Top-level tabId conflicts with command tabId", { cmd: commandName, tabId: topLevelTabId, commandTabId });
		}
		this.assertSameTabId(topLevelTabId ?? targetTabId, commandTabId, { commandName, left: "outer target", right: "command.tabId", target });
		const explicitTabId = topLevelTabId ?? targetTabId ?? commandTabId;
		const logical = !!(target?.orchestrationId || target?.sessionTag || target?.tabRole);
		if (logical) {
			const resolved = this.resolveOrchestrationTarget(target, explicitTabId, { toolName: input.toolName, commandName });
			this.assertSameTabId(explicitTabId, resolved.tabId, { commandName, left: "explicit tabId", right: "orchestration binding", target });
			return resolved;
		}
		if (target && explicitTabId === undefined && target.browserId) {
			throw new BrowserBridgeError("TARGET_NOT_FOUND", "Target browserId without tabId or orchestration binding cannot resolve a tab-scoped target", { toolName: input.toolName, commandName, target: compactTarget(target) });
		}
		if (target && explicitTabId === undefined && !input.allowEmptyTarget) throw new BrowserBridgeError("TARGET_NOT_FOUND", "Target object does not identify a browser tab", { toolName: input.toolName, commandName, target: compactTarget(target) });
		if (explicitTabId === undefined) return undefined;
		const session = this.tabs.liveSessionForTabTarget(explicitTabId, target?.browserId);
		if (!session) {
			const code = target ? "TARGET_NOT_FOUND" : "TAB_NOT_FOUND";
			throw new BrowserBridgeError(code, "Target browser tab is not connected", { toolName: input.toolName, commandName, tabId: explicitTabId, browserId: target?.browserId, target: compactTarget(target), tabs: this.getTabs() });
		}
		return this.tabs.targetInfo("explicit", explicitTabId, { browserId: session.browserId });
	}

	private normalizeExplicitTabId(value: unknown, source: string, commandName?: string): number | undefined {
		if (value === undefined) return undefined;
		const tabId = toTabId(value);
		if (tabId === undefined) throw new BrowserBridgeError("INVALID_TAB_ID", "A valid tabId is required", { cmd: commandName, tabId: value, source });
		return tabId;
	}

	private normalizeToolTarget(value: unknown, options: { allowEmpty?: boolean; commandName?: string } = {}): NormalizedToolTarget | undefined {
		if (value === undefined || value === null) return undefined;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrowserBridgeError("TARGET_INVALID", "target must be an object", { cmd: options.commandName, target: value });
		const record = value as Record<string, unknown>;
		const unknownFields = Object.keys(record).filter((key) => !TARGET_FIELDS.has(key));
		if (unknownFields.length) throw new BrowserBridgeError("TARGET_INVALID", "target contains unsupported fields", { cmd: options.commandName, fields: unknownFields });
		const tabId = record.tabId === undefined ? undefined : this.normalizeExplicitTabId(record.tabId, "target", options.commandName);
		const windowId = record.windowId === undefined ? undefined : this.normalizeExplicitTabId(record.windowId, "target.windowId", options.commandName);
		const groupId = record.groupId === undefined ? undefined : this.normalizeExplicitTabId(record.groupId, "target.groupId", options.commandName);
		const target: NormalizedToolTarget = {
			tabId,
			browserId: normalizedString(record.browserId),
			orchestrationId: normalizedString(record.orchestrationId),
			sessionTag: normalizedString(record.sessionTag),
			tabRole: normalizedString(record.tabRole),
			windowId,
			groupId,
			profileId: normalizedString(record.profileId),
			requireOwned: record.requireOwned === true,
		};
		const hasAny = Object.values(target).some((item) => item !== undefined && item !== false);
		if (!hasAny && !options.allowEmpty) throw new BrowserBridgeError("TARGET_NOT_FOUND", "target object does not identify a browser tab", { cmd: options.commandName });
		return target;
	}

	private assertSameTabId(left: number | undefined, right: number | undefined, context: { commandName?: string; left: string; right: string; target?: unknown }): void {
		if (left === undefined || right === undefined || left === right) return;
		throw new BrowserBridgeError("TARGET_CONFLICT", "Conflicting browser target tab ids were supplied", { cmd: context.commandName, left: context.left, right: context.right, leftTabId: left, rightTabId: right, target: compactTarget(context.target) });
	}

	private resolveOrchestrationTarget(target: NormalizedToolTarget | undefined, explicitTabId: number | undefined, context: ResolveContext): BrowserBridgeTargetInfo {
		if (!target?.sessionTag || !target.tabRole) throw new BrowserBridgeError("TARGET_INVALID", "orchestration target requires sessionTag and tabRole", { toolName: context.toolName, commandName: context.commandName, target: compactTarget(target) });
		const states = this.store.list();
		if (target.orchestrationId && !states.some((state) => state.orchestrationId === target.orchestrationId)) {
			throw new BrowserBridgeError("ORCHESTRATION_SESSION_NOT_FOUND", "Orchestration state is not found", { toolName: context.toolName, commandName: context.commandName, orchestrationId: target.orchestrationId });
		}
		const candidates = states.flatMap((state) => {
			if (target.orchestrationId && state.orchestrationId !== target.orchestrationId) return [];
			return state.bindings
				.filter((binding) => binding.sessionTag === target.sessionTag && binding.tabRole === target.tabRole)
				.map((binding) => ({ orchestrationId: state.orchestrationId, binding }));
		});
		if (candidates.length === 0) throw new BrowserBridgeError("TARGET_NOT_FOUND", "No orchestration binding matches target", { toolName: context.toolName, commandName: context.commandName, target: compactTarget(target), states: states.map((state) => ({ orchestrationId: state.orchestrationId, bindings: state.bindings.map((binding) => ({ sessionTag: binding.sessionTag, tabRole: binding.tabRole, browserId: binding.browserId, tabId: binding.tabId, owned: binding.owned })) })) });
		const browserFiltered = target.browserId ? candidates.filter((item) => this.targetBrowserMatchesBinding(item.binding.browserId, item.binding.tabId, target.browserId as string)) : candidates;
		if (target.browserId && browserFiltered.length === 0) throw new BrowserBridgeError("TARGET_BROWSER_CONFLICT", "Target browserId conflicts with orchestration binding", { toolName: context.toolName, commandName: context.commandName, browserId: target.browserId, target: compactTarget(target), candidates: candidates.map((item) => ({ orchestrationId: item.orchestrationId, browserId: item.binding.browserId, tabId: item.binding.tabId })) });
		const ownedFiltered = target.requireOwned ? browserFiltered.filter((item) => item.binding.owned) : browserFiltered;
		if (ownedFiltered.length === 0) throw new BrowserBridgeError("TARGET_NOT_FOUND", "No owned orchestration binding matches target", { toolName: context.toolName, commandName: context.commandName, target: compactTarget(target) });
		if (ownedFiltered.length > 1) throw new BrowserBridgeError("TARGET_AMBIGUOUS", "Logical browser target matches multiple orchestration bindings", { toolName: context.toolName, commandName: context.commandName, target: compactTarget(target), candidates: ownedFiltered.map((item) => ({ orchestrationId: item.orchestrationId, browserId: item.binding.browserId, tabId: item.binding.tabId, owned: item.binding.owned })) });
		const resolved = ownedFiltered[0];
		this.assertSameTabId(explicitTabId, resolved.binding.tabId, { commandName: context.commandName, left: "explicit tabId", right: "orchestration binding", target });
		const session = this.tabs.liveSessionForTabTarget(resolved.binding.tabId, resolved.binding.browserId);
		if (!session) throw new BrowserBridgeError("ORCHESTRATION_TARGET_STALE", "Orchestration target binding does not reference a live tab", { toolName: context.toolName, commandName: context.commandName, target: compactTarget(target), orchestrationId: resolved.orchestrationId, binding: { sessionTag: resolved.binding.sessionTag, tabRole: resolved.binding.tabRole, browserId: resolved.binding.browserId, tabId: resolved.binding.tabId, owned: resolved.binding.owned }, tabs: this.getTabs() });
		return this.tabs.targetInfo("orchestration", resolved.binding.tabId, { browserId: resolved.binding.browserId, orchestrationId: resolved.orchestrationId, sessionTag: resolved.binding.sessionTag, tabRole: resolved.binding.tabRole });
	}

	private targetBrowserMatchesBinding(bindingBrowserId: string, tabId: number, targetBrowserId: string): boolean {
		if (bindingBrowserId === targetBrowserId) return true;
		const session = this.tabs.liveSessionForTabTarget(tabId, bindingBrowserId);
		return session?.bridge?.extensionId === targetBrowserId || session?.bridge?.id === targetBrowserId;
	}
}
