import type { BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserTabInfo, ExecuteOptions } from "../types";
import type { BridgeCommand } from "../../protocol/nativeProtocol";

export type JsonRecord = Record<string, unknown>;

export type BrowserOrchestrationAction = "plan" | "apply" | "status" | "delete" | "watch" | "stop";
export type BrowserOrchestrationPhase = "profile" | "observe" | "window" | "tab" | "visual-grouping" | "recorder-pre-nav" | "hook-pre-nav" | "cookie" | "navigation" | "recorder" | "hook" | "verify" | "cleanup";
export type BrowserOrchestrationOperationAction = "ensureProfile" | "stopProfile" | "createWindow" | "createTab" | "reuseTab" | "groupTabs" | "startNetwork" | "installPreNavigationHook" | "setCookie" | "removeCookie" | "navigate" | "installHook" | "verifyStatus" | "closeTab" | "closeWindow" | "stopNetwork" | "uninstallHook" | "uninstallPreNavigationHook";
export type BrowserOrchestrationOperationStatus = "pending" | "succeeded" | "degraded" | "failed" | "skipped";

export const ORCHESTRATION_PHASE_ORDER: BrowserOrchestrationPhase[] = ["profile", "observe", "window", "tab", "visual-grouping", "recorder-pre-nav", "hook-pre-nav", "cookie", "navigation", "recorder", "hook", "verify", "cleanup"];

export type BrowserManagedProfileInfo = { profileId: string; profileDir?: string; extensionDir?: string; bridgePort?: number; debugPort?: number; browserId?: string; browserExtensionId?: string; processId?: number; owned: true; cleanup?: string; connectedAt?: number };

export type BrowserOrchestrationServer = {
	snapshot(): BrowserBridgeSnapshot;
	getTabs?(options?: { includeDisconnected?: boolean }): BrowserTabInfo[];
	refreshTabs?(timeoutMs?: number): Promise<BrowserTabInfo[]>;
	selectBrowser?(browserId: string): unknown;
	createTab(url: string, active?: boolean, timeoutMs?: number): Promise<BrowserBridgeExecutionResult>;
	closeTab(tabId: number | string, timeoutMs?: number, options?: { browserId?: string }): Promise<BrowserBridgeExecutionResult>;
	sendCommand(command: BridgeCommand, options?: ExecuteOptions): Promise<BrowserBridgeExecutionResult>;
	waitForExtensionReconnect?(previousClientId: string | undefined, timeoutMs?: number): Promise<BrowserBridgeSnapshot>;
	ensureManagedProfile?(options: { profileId: string; initialUrl?: string; reuse?: "none" | "owned"; cleanup?: "delete" | "keepOnFailure"; timeoutMs?: number }): Promise<BrowserManagedProfileInfo>;
	stopManagedProfile?(profileId: string, options?: { deleteFiles?: boolean; timeoutMs?: number }): Promise<BrowserManagedProfileInfo | undefined>;
};

export type BrowserDesiredCookieInput = {
	url?: unknown;
	tabRole?: unknown;
	name?: unknown;
	value?: unknown;
	remove?: unknown;
	domain?: unknown;
	path?: unknown;
	storeId?: unknown;
	partitionKey?: unknown;
	secure?: unknown;
	httpOnly?: unknown;
	sameSite?: unknown;
	expirationDate?: unknown;
	required?: unknown;
};

export type BrowserDesiredTabInput = {
	role?: unknown;
	url?: unknown;
	reuse?: unknown;
	active?: unknown;
	waitUntil?: unknown;
	recreateOnMissing?: unknown;
	required?: unknown;
};

export type BrowserDesiredPreNavigationHookInput = {
	hookId?: unknown;
	enabled?: unknown;
	params?: unknown;
	scope?: unknown;
	version?: unknown;
	hash?: unknown;
	required?: unknown;
};

export type BrowserOrchestrationAdoptionInput = {
	enabled?: unknown;
	orchestrationId?: unknown;
	resourceTypes?: unknown;
	verifyOrigins?: unknown;
	verifyUrls?: unknown;
	verifyBrowserIds?: unknown;
	verifyWindowIds?: unknown;
	verifyProfileIds?: unknown;
	requireOwnedFingerprint?: unknown;
};

export type BrowserDesiredSessionInput = {
	tag?: unknown;
	required?: unknown;
	url?: unknown;
	tabs?: unknown;
	cookies?: unknown;
	networkRecorder?: unknown;
	hookDispatcher?: unknown;
	ownedWindow?: unknown;
	visualGrouping?: unknown;
	preNavigationHooks?: unknown;
};

export type BrowserOrchestrationProfileIsolationInput = { profileId?: unknown; lifecycle?: unknown; reuse?: unknown; cleanup?: unknown };

export type BrowserOrchestrationDesiredInput = {
	apiVersion?: unknown;
	orchestrationId?: unknown;
	generation?: unknown;
	browser?: unknown;
	defaults?: unknown;
	isolation?: unknown;
	windowIsolation?: unknown;
	visualGrouping?: unknown;
	preNavigationHooks?: unknown;
	adoption?: unknown;
	allowedOrigins?: unknown;
	ttlMs?: unknown;
	sessions?: unknown;
};

export type NormalizedBrowserSelection = {
	browserId?: string;
	requireSelected: boolean;
	crossBrowserFallback: false;
};

export type NormalizedOrchestrationDefaults = {
	timeoutMs: number;
	navigationTimeoutMs: number;
	tabRole: string;
	cleanupOnFailure: boolean;
};

export type NormalizedOrchestrationProfileIsolation = {
	profileId: string;
	lifecycle: "managed";
	reuse: "none" | "owned";
	cleanup: "delete" | "keepOnFailure";
};

export type NormalizedOrchestrationIsolation = {
	scope: "logical" | "browser" | "profile";
	ownedTabsOnly: boolean;
	closeOwnedTabsOnDelete: boolean;
	profile?: NormalizedOrchestrationProfileIsolation;
};

export type NormalizedDesiredTab = {
	sessionTag: string;
	role: string;
	url: string;
	origin: string;
	reuse: "none" | "matchingUrl" | "owned";
	active: boolean;
	waitUntil: "none" | "domcontentloaded" | "complete" | "networkIdle";
	recreateOnMissing: boolean;
	required: boolean;
};

export type NormalizedDesiredCookie = {
	key: string;
	sessionTag: string;
	tabRole: string;
	url: string;
	origin: string;
	name: string;
	action: "set" | "remove";
	value?: string;
	valueHash?: string;
	domain?: string;
	path?: string;
	storeId?: string;
	partitionKey?: JsonRecord;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
	expirationDate?: number;
	required: boolean;
};

export type NormalizedNetworkRecorder = {
	enabled: boolean;
	sessionId?: string;
	startBeforeNavigate: boolean;
	required: boolean;
	config: JsonRecord;
};

export type NormalizedHookDispatcher = {
	enabled: boolean;
	sessionId?: string;
	required: boolean;
	targets?: unknown;
	options?: unknown;
	bufferSize?: number;
	force: boolean;
	expectedVersion?: string;
	installFingerprint?: string;
};

export type NormalizedOwnedWindow = {
	enabled: boolean;
	focused: boolean;
	state?: "normal" | "minimized" | "maximized" | "fullscreen";
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	closeOnDelete: boolean;
};

export type NormalizedVisualGrouping = {
	enabled: boolean;
	title?: string;
	color?: string;
	collapsed?: boolean;
	required: false;
};

export type NormalizedPreNavigationHookScope = {
	tabRoles?: string[];
	origins?: string[];
	allFrames: boolean;
	matchAboutBlank: boolean;
};

export type NormalizedPreNavigationHookMetadata = {
	hookId: string;
	enabled: boolean;
	params: JsonRecord;
	scope: NormalizedPreNavigationHookScope;
	version: string;
	hash: string;
	required: boolean;
	installPhase: "pre-navigation";
};

export type PreNavigationHookRegistryEntry = {
	hookId: string;
	version: string;
	hash: string;
	builtin: boolean;
	assetPath?: string;
	paramsSchema?: JsonRecord;
};

export type PreNavigationHookRegistration = {
	hookId: string;
	version: string;
	hash: string;
	identifier: string;
	sessionKey?: string;
	cdpSessionName: string;
	sessionTag: string;
	tabRole: string;
	installedAt: number;
	effectVerifiedAt?: number;
	workerBootId?: string;
};

export type NormalizedDesiredSession = {
	tag: string;
	required: boolean;
	tabs: NormalizedDesiredTab[];
	cookies: NormalizedDesiredCookie[];
	ownedWindow: NormalizedOwnedWindow;
	visualGrouping: NormalizedVisualGrouping;
	preNavigationHooks: NormalizedPreNavigationHookMetadata[];
	networkRecorder?: NormalizedNetworkRecorder;
	hookDispatcher?: NormalizedHookDispatcher;
};

export type NormalizedBrowserOrchestrationDesired = {
	apiVersion: "pi.browser/v1";
	orchestrationId: string;
	generation: string;
	desiredHash: string;
	browser: NormalizedBrowserSelection;
	defaults: NormalizedOrchestrationDefaults;
	isolation: NormalizedOrchestrationIsolation;
	allowedOrigins: string[];
	ttlMs?: number;
	sessions: NormalizedDesiredSession[];
	adoption?: OrchestrationAdoptionPolicy;
};

export type OrchestrationBinding = {
	sessionTag: string;
	tabRole: string;
	browserId: string;
	browserExtensionId?: string;
	tabId: number;
	windowId?: number;
	windowOwned?: boolean;
	windowCloseOnDelete?: boolean;
	groupId?: number;
	profileId?: string;
	tabGroupsStatus?: "available" | "degraded_not_supported" | "degraded_operation_failed" | "disabled";
	owned: boolean;
	desiredUrl: string;
	createdByOrchestrator: boolean;
	createdAt: number;
	updatedAt: number;
	networkSessionId?: string;
	networkConfigHash?: string;
	hookSessionId?: string;
	hookFingerprint?: string;
	preNavigationHooks?: PreNavigationHookRegistration[];
	preNavigationHookDegraded?: Array<{ hookId: string; version: string; hash: string; code?: string; message?: string; updatedAt: number }>;
	workerBootId?: string;
};

export type OrchestrationWatchState = {
	active: boolean;
	intervalMs: number;
	expiresAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	failures: number;
	maxAttempts?: number;
	paused?: boolean;
	pauseReason?: string;
	lastFailure?: OrchestrationFailure;
	recoveries?: number;
};

export type OrchestrationRuntimeState = {
	orchestrationId: string;
	generation: string;
	desiredHash: string;
	createdAt: number;
	updatedAt: number;
	deletedAt?: number;
	cleanupOnFailure: boolean;
	closeOwnedTabsOnDelete: boolean;
	watch?: OrchestrationWatchState;
	bindings: OrchestrationBinding[];
	redactedDesired?: unknown;
	workerBootId?: string;
	lastActual?: BrowserOrchestrationActual;
	lastPlan?: BrowserOrchestrationPlanSummary;
	lastResult?: BrowserOrchestrationResultSummary;
	lastFailures?: OrchestrationFailure[];
	persistence?: OrchestrationPersistenceMetadata;
};

export type OrchestrationPersistenceSchemaVersion = "pi.browser.orchestration.state/v1";
export type OrchestrationPersistenceMode = "diagnostic" | "adoption_pending" | "adopted_current";
export type OrchestrationPersistenceStatus = "current" | "stale" | "read_only" | "adoption_required" | "adopted";
export type OrchestrationPersistenceResourceType = "tab" | "window" | "networkRecorder" | "hookDispatcher" | "preNavigationHook" | "cookie";

export type OrchestrationPersistenceMetadata = {
	schemaVersion: OrchestrationPersistenceSchemaVersion;
	driverRunId: string;
	piSessionId: string;
	status: OrchestrationPersistenceStatus;
	readOnly: boolean;
	adoptionRequired: boolean;
	loadedAt?: number;
	adoptedAt?: number;
	path?: string;
};

export type OrchestrationPersistedResourceFingerprint = {
	sessionTag: string;
	tabRole: string;
	browserId?: string;
	browserExtensionId?: string;
	tabId?: number;
	windowId?: number;
	profileId?: string;
	origin?: string;
	url?: string;
	desiredUrl?: string;
	workerBootId?: string;
	networkSessionId?: string;
	networkConfigHash?: string;
	hookSessionId?: string;
	hookFingerprint?: string;
	preNavigationHookHashes?: string[];
	cookieKeys?: string[];
	owned?: boolean;
	createdByOrchestrator?: boolean;
};

export type OrchestrationPersistedBinding = {
	sessionTag: string;
	tabRole: string;
	browserId: string;
	browserExtensionId?: string;
	tabId: number;
	windowId?: number;
	windowOwned?: boolean;
	windowCloseOnDelete?: boolean;
	groupId?: number;
	profileId?: string;
	tabGroupsStatus?: OrchestrationBinding["tabGroupsStatus"];
	owned: boolean;
	createdByOrchestrator: boolean;
	desiredUrl: string;
	createdAt: number;
	updatedAt: number;
	networkSessionId?: string;
	networkConfigHash?: string;
	hookSessionId?: string;
	hookFingerprint?: string;
	preNavigationHooks?: PreNavigationHookRegistration[];
	workerBootId?: string;
	fingerprint: OrchestrationPersistedResourceFingerprint;
};

export type OrchestrationPersistedCookieFingerprint = {
	key: string;
	sessionTag: string;
	tabRole: string;
	origin: string;
	name: string;
	action: "set" | "remove";
	domain?: string;
	path?: string;
	storeId?: string;
	partitionKeyHash?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: NormalizedDesiredCookie["sameSite"];
	expirationDate?: number;
	valueHash?: string;
	valuePresent?: boolean;
};

export type OrchestrationPersistedRecord = {
	orchestrationId: string;
	generation: string;
	desiredHash: string;
	createdAt: number;
	updatedAt: number;
	deletedAt?: number;
	cleanupOnFailure?: boolean;
	closeOwnedTabsOnDelete?: boolean;
	redactedDesired: unknown;
	bindings: OrchestrationPersistedBinding[];
	cookies: OrchestrationPersistedCookieFingerprint[];
	fingerprints: OrchestrationPersistedResourceFingerprint[];
	status: OrchestrationPersistenceStatus;
	readOnly: boolean;
	adoptionRequired: boolean;
	adoptedAt?: number;
};

export type OrchestrationAdoptionPolicy = {
	enabled: true;
	orchestrationId: string;
	resourceTypes: OrchestrationPersistenceResourceType[];
	verifyOrigins: string[];
	verifyUrls: string[];
	verifyBrowserIds?: string[];
	verifyWindowIds?: number[];
	verifyProfileIds?: string[];
	requireOwnedFingerprint: boolean;
};

export type OrchestrationPersistedStateFile = {
	schemaVersion: OrchestrationPersistenceSchemaVersion;
	createdAt: number;
	updatedAt: number;
	driverRunId: string;
	piSessionId: string;
	mode: OrchestrationPersistenceMode;
	privacy: {
		classification: "local_redacted_orchestration_state";
		localOnly: true;
		redaction: "required";
		cleanup: string;
	};
	orchestrations: OrchestrationPersistedRecord[];
};

export type ActualCookieState = {
	key: string;
	name: string;
	action: "set" | "remove";
	present?: boolean;
	valueHash?: string;
	drift?: boolean;
	error?: string;
};

export type ActualRecorderState = {
	desired: boolean;
	active: boolean;
	sessionId?: string;
	config?: JsonRecord;
	configHash?: string;
	error?: string;
	details?: JsonRecord;
};

export type ActualHookState = {
	desired: boolean;
	installed: boolean;
	state?: string;
	sessionId?: string;
	installFingerprint?: string;
	error?: string;
	details?: JsonRecord;
};

export type ActualPreNavigationHookState = {
	desired: boolean;
	hookId: string;
	version: string;
	hash: string;
	registered: boolean;
	identifier?: string;
	sessionKey?: string;
	cdpSessionName?: string;
	workerBootId?: string;
	stale?: boolean;
	effectActive?: boolean;
	error?: string;
	details?: JsonRecord;
};

export type ActualTabState = {
	sessionTag: string;
	role: string;
	desiredUrl: string;
	tabId?: number;
	browserId?: string;
	browserExtensionId?: string;
	windowId?: number;
	windowOwned?: boolean;
	windowCloseOnDelete?: boolean;
	groupId?: number;
	profileId?: string;
	tabGroupsStatus?: string;
	exists: boolean;
	url?: string;
	active?: boolean;
	owned: boolean;
	createdByOrchestrator?: boolean;
	candidateTabIds?: number[];
	browserMismatch?: boolean;
	navigation: { matchesDesired: boolean; urlMatchesDesired: boolean; loadState?: string; loadStateMatchesDesired?: boolean; error?: string };
	networkRecorder?: ActualRecorderState;
	preNavigationHooks?: ActualPreNavigationHookState[];
	hookDispatcher?: ActualHookState;
	cookies: ActualCookieState[];
};

export type BrowserOrchestrationActual = {
	observedAt: number;
	bridge: {
		running: boolean;
		extensionConnected: boolean;
		selectedBrowserId?: string;
		selectedExtensionId?: string;
		workerBootId?: string;
	};
	tabs: BrowserTabInfo[];
	windows?: JsonRecord[];
	tabGroups?: JsonRecord;
	profiles?: BrowserManagedProfileInfo[];
	sessions: Array<{ tag: string; tabs: ActualTabState[]; cookies: ActualCookieState[] }>;
	diagnostics: Array<JsonRecord>;
};

export type ReconcileOperationResourceRef = {
	orchestrationId: string;
	sessionTag: string;
	tabRole: string;
	tabId?: number;
	browserId?: string;
	windowId?: number;
	groupId?: number;
	profileId?: string;
	cookieKey?: string;
	cookieName?: string;
	sessionId?: string;
	hookId?: string;
	hookVersion?: string;
	hookHash?: string;
	hookIdentifier?: string;
};

export type ReconcileOperation = {
	id: string;
	phase: BrowserOrchestrationPhase;
	action: BrowserOrchestrationOperationAction;
	resourceRef: ReconcileOperationResourceRef;
	reason: string;
	dependsOn?: string[];
	idempotencyKey: string;
	required: boolean;
	redactedParams: JsonRecord;
};

export type BrowserOrchestrationPlan = {
	orchestrationId: string;
	generation: string;
	desiredHash: string;
	createdAt: number;
	actual: BrowserOrchestrationActual;
	operations: ReconcileOperation[];
	converged: boolean;
	diagnostics: JsonRecord[];
};

export type BrowserOrchestrationPlanSummary = {
	operationCount: number;
	operationsByPhase: Record<string, number>;
	converged: boolean;
};

export type OrchestrationFailure = {
	operationId?: string;
	code: string;
	message: string;
	retryable: boolean;
	details?: JsonRecord;
};

export type ReconcileOperationResult = {
	operationId: string;
	phase: BrowserOrchestrationPhase;
	action: BrowserOrchestrationOperationAction;
	resourceRef: ReconcileOperationResourceRef;
	status: BrowserOrchestrationOperationStatus;
	startedAt: number;
	finishedAt: number;
	reason: string;
	required: boolean;
	redactedParams: JsonRecord;
	result?: JsonRecord;
	failure?: OrchestrationFailure;
};

export type BrowserOrchestrationApplyResult = {
	ok: boolean;
	action: "apply" | "delete";
	orchestrationId: string;
	generation: string;
	converged: boolean;
	desiredHash?: string;
	bindings: OrchestrationBinding[];
	operationResults: ReconcileOperationResult[];
	failures: OrchestrationFailure[];
	actual?: BrowserOrchestrationActual;
	plan?: BrowserOrchestrationPlanSummary;
	persistence?: JsonRecord;
};

export type BrowserOrchestrationPlanResult = {
	ok: true;
	action: "plan";
	orchestrationId: string;
	generation: string;
	desiredHash: string;
	redactedDesired: unknown;
	actual: BrowserOrchestrationActual;
	plan: BrowserOrchestrationPlan;
};

export type BrowserOrchestrationStatusResult = {
	ok: boolean;
	action: "status";
	orchestrationId?: string;
	states?: OrchestrationRuntimeState[];
	state?: OrchestrationRuntimeState;
	actual?: BrowserOrchestrationActual;
	plan?: BrowserOrchestrationPlanSummary;
	converged?: boolean;
	failures?: OrchestrationFailure[];
	persistence?: JsonRecord;
};

export type BrowserOrchestrationResultSummary = {
	ok: boolean;
	converged: boolean;
	operationCount: number;
	failureCount: number;
	updatedAt: number;
};

export type BrowserOrchestrationRunOptions = {
	timeoutMs?: number;
	now?: number;
};

export type BrowserOrchestrationWatchOptions = BrowserOrchestrationRunOptions & {
	intervalMs?: number;
	ttlMs?: number;
	maxAttempts?: number;
};

export type BrowserOrchestrationWatchResult = Omit<BrowserOrchestrationApplyResult, "action"> & {
	action: "watch";
	watch: NonNullable<OrchestrationRuntimeState["watch"]>;
};

export type BrowserOrchestrationStopResult = {
	ok: boolean;
	action: "stop";
	orchestrationId: string;
	stopped: boolean;
	operationResults?: ReconcileOperationResult[];
	failures?: OrchestrationFailure[];
	state?: OrchestrationRuntimeState;
	persistence?: JsonRecord;
};
