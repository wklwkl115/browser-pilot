import { Buffer } from "node:buffer";

export type HeaderMap = Record<string, string>;
export type CookieProvider = (url: string) => Promise<string | undefined>;

export type WebFetchOptions = {
	followRedirects?: boolean;
	maxRedirects?: number;
	timeoutMs?: number;
	maxBodyBytes?: number;
};

export type RawProbeOptions = WebFetchOptions & {
	url?: unknown;
	urls?: unknown;
	paths?: unknown;
	ports?: unknown;
	schemes?: unknown;
	method?: unknown;
	headers?: unknown;
	defaultScheme?: unknown;
	includeFaviconHash?: unknown;
	includeTlsCertificate?: unknown;
	bindBrowserSession?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawReplayOptions = WebFetchOptions & {
	url?: unknown;
	baseUrl?: unknown;
	rawRequest?: unknown;
	request?: unknown;
	har?: unknown;
	harPath?: unknown;
	harEntryIndex?: unknown;
	harUrlPattern?: unknown;
	harMaxEntries?: unknown;
	requests?: unknown;
	sequence?: unknown;
	multipart?: unknown;
	compareBaseline?: unknown;
	sequenceCookies?: unknown;
	continueOnError?: unknown;
	variables?: unknown;
	variableScope?: unknown;
	method?: unknown;
	headers?: unknown;
	body?: unknown;
	bodyBase64?: unknown;
	mutations?: unknown;
	defaultScheme?: unknown;
	bindBrowserSession?: unknown;
	cookieMode?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawCrawlOptions = WebFetchOptions & {
	url?: unknown;
	urls?: unknown;
	paths?: unknown;
	headers?: unknown;
	defaultScheme?: unknown;
	maxDepth?: unknown;
	maxPages?: unknown;
	sameOrigin?: unknown;
	knownFiles?: unknown;
	extractJs?: unknown;
	activeGraphqlIntrospection?: unknown;
	bindBrowserSession?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawFuzzPathsOptions = WebFetchOptions & {
	url?: unknown;
	urls?: unknown;
	words?: unknown;
	wordlist?: unknown;
	wordlistPath?: unknown;
	paths?: unknown;
	extensions?: unknown;
	appendSlash?: unknown;
	recursive?: unknown;
	maxDepth?: unknown;
	method?: unknown;
	headers?: unknown;
	defaultScheme?: unknown;
	matchStatus?: unknown;
	filterStatus?: unknown;
	filterBodyBytes?: unknown;
	filterBaseline?: unknown;
	baselinePath?: unknown;
	baselineStrategy?: unknown;
	maxCandidates?: unknown;
	rateLimitPerSecond?: unknown;
	bindBrowserSession?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawFuzzParamsOptions = RawReplayOptions & {
	locations?: unknown;
	paramNames?: unknown;
	values?: unknown;
	jsonValues?: unknown;
	words?: unknown;
	wordlist?: unknown;
	wordlistPath?: unknown;
	operations?: unknown;
	contentTypeVariants?: unknown;
	matchStatus?: unknown;
	filterStatus?: unknown;
	filterBodyBytes?: unknown;
	maxCases?: unknown;
	rateLimitPerSecond?: unknown;
};

export type RawFuzzVhostsOptions = WebFetchOptions & {
	url?: unknown;
	urls?: unknown;
	hosts?: unknown;
	words?: unknown;
	wordlist?: unknown;
	wordlistPath?: unknown;
	baseDomain?: unknown;
	template?: unknown;
	baselineHost?: unknown;
	baselineHosts?: unknown;
	sniMode?: unknown;
	sniName?: unknown;
	method?: unknown;
	headers?: unknown;
	defaultScheme?: unknown;
	matchStatus?: unknown;
	filterStatus?: unknown;
	filterBodyBytes?: unknown;
	filterBaseline?: unknown;
	baselineStrategy?: unknown;
	maxCandidates?: unknown;
	rateLimitPerSecond?: unknown;
	bindBrowserSession?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawCookieAnalyzeOptions = {
	url?: unknown;
	cookie?: unknown;
	cookies?: unknown;
	setCookie?: unknown;
	setCookies?: unknown;
	jwt?: unknown;
	jwts?: unknown;
	values?: unknown;
	secretCandidates?: unknown;
	secrets?: unknown;
	wordlist?: unknown;
	wordlistPath?: unknown;
	maxSecretCandidates?: unknown;
	claimMutations?: unknown;
	claimReplay?: unknown;
	bindBrowserSession?: unknown;
	cookieProvider?: CookieProvider;
};

export type RawSqliProbeOptions = RawFuzzParamsOptions & {
	probeTypes?: unknown;
	payloadMode?: unknown;
	dbms?: unknown;
	booleanPayloadPairs?: unknown;
	errorPayloads?: unknown;
	timePayloads?: unknown;
	unionPayloads?: unknown;
	unionEcho?: unknown;
	orderByMax?: unknown;
	unionColumnMax?: unknown;
	extractExpression?: unknown;
	extractMaxLength?: unknown;
	extractCharset?: unknown;
	payloads?: unknown;
	timeThresholdMs?: unknown;
	baselineRepeats?: unknown;
	stopOnFirstMatch?: unknown;
};

export type RawTemplateCheckOptions = RawReplayOptions & {
	urls?: unknown;
	paths?: unknown;
	templateIds?: unknown;
	templates?: unknown;
	templatePath?: unknown;
	variables?: unknown;
	tech?: unknown;
	maxTemplates?: unknown;
	rateLimitPerSecond?: unknown;
};

export type RawSqlmapBridgeOptions = RawReplayOptions & {
	paramNames?: unknown;
	technique?: unknown;
	dbms?: unknown;
	level?: unknown;
	risk?: unknown;
	threads?: unknown;
	timeoutSeconds?: unknown;
	retries?: unknown;
	batch?: unknown;
	flushSession?: unknown;
	answers?: unknown;
	currentDb?: unknown;
	currentUser?: unknown;
	isDba?: unknown;
	banner?: unknown;
	tamper?: unknown;
	sqlmapPath?: unknown;
	sqlmapArgs?: unknown;
	extraArgs?: unknown;
};

export type RawNucleiBridgeOptions = RawReplayOptions & {
	urls?: unknown;
	paths?: unknown;
	templatePaths?: unknown;
	workflowPaths?: unknown;
	templateIds?: unknown;
	tags?: unknown;
	excludeTags?: unknown;
	severities?: unknown;
	authors?: unknown;
	timeoutSeconds?: unknown;
	retries?: unknown;
	rateLimitPerSecond?: unknown;
	concurrency?: unknown;
	bulkSize?: unknown;
	nucleiPath?: unknown;
	nucleiArgs?: unknown;
	extraArgs?: unknown;
};

export type RawCallbackOastOptions = {
	action?: unknown;
	sessionId?: unknown;
	listenHost?: unknown;
	port?: unknown;
	publicBaseUrl?: unknown;
	publicHttpsBaseUrl?: unknown;
	basePath?: unknown;
	correlationId?: unknown;
	responseStatus?: unknown;
	responseBody?: unknown;
	responseHeaders?: unknown;
	enableHttps?: unknown;
	httpsPort?: unknown;
	enableDns?: unknown;
	dnsListenHost?: unknown;
	dnsPort?: unknown;
	dnsBaseDomain?: unknown;
	publicDnsBaseDomain?: unknown;
	dnsResponseAddress?: unknown;
	externalMetadata?: unknown;
	mode?: unknown;
	triggerMode?: unknown;
	target?: unknown;
	triggerTarget?: unknown;
	method?: unknown;
	triggerMethod?: unknown;
	requestHeaders?: unknown;
	headers?: unknown;
	body?: unknown;
	triggerBody?: unknown;
	bodyBase64?: unknown;
	triggerBodyBase64?: unknown;
	queryName?: unknown;
	queryType?: unknown;
	resolverHost?: unknown;
	resolverPort?: unknown;
	rejectUnauthorized?: unknown;
	maxEvents?: unknown;
	maxBodyBytes?: unknown;
	afterSeq?: unknown;
	timeoutMs?: unknown;
};

export type ProbeOptions = RawProbeOptions;
export type ReplayOptions = RawReplayOptions;
export type CrawlOptions = RawCrawlOptions;
export type FuzzPathsOptions = RawFuzzPathsOptions;
export type FuzzParamsOptions = RawFuzzParamsOptions;
export type FuzzVhostsOptions = RawFuzzVhostsOptions;
export type CookieAnalyzeOptions = RawCookieAnalyzeOptions;
export type SqliProbeOptions = RawSqliProbeOptions;
export type TemplateCheckOptions = RawTemplateCheckOptions;
export type SqlmapBridgeOptions = RawSqlmapBridgeOptions;
export type NucleiBridgeOptions = RawNucleiBridgeOptions;
export type CallbackOastOptions = RawCallbackOastOptions;

export type FetchRequest = {
	url: string;
	method: string;
	headers: HeaderMap;
	body?: string | Buffer;
};

export type FetchStep = {
	url: string;
	status: number;
	statusText: string;
	ok: boolean;
	headers: HeaderMap;
	setCookie: string[];
	elapsedMs: number;
	bodyText: string;
	bodyBytes: number;
	bodyTruncated: boolean;
	bodyBase64?: string;
};

export type FetchExchange = {
	chain: FetchStep[];
	final: FetchStep;
};

export type ReplayRequest = FetchRequest & {
	multipart?: Record<string, unknown>;
};
