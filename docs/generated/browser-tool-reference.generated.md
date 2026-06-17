# Browser Tool Reference

Generated reference for the shipped `browser_*` tools.

> For each tool's **intent vs mechanical (plumbing)** parameter split (architecture-charter.md 铁律 #16), see `docs/generated/tool-parameter-doctrine.generated.md` or the live `browser-pilot schema <cmd> --json` (`paramClass` per flag). The flat `Parameters` column below does not encode that split.

## Source summary

- Tool metadata source: `src/commands/**/*Command*.ts` command manifest metadata/config objects.
- Native command source: `src/bridge/protocol/native-command.schema.json` (browser-pilot-native-commands 0.2.0).
- Error taxonomy source: `src/bridge/protocol/native-command.schema.json` plus local `src/**` and `src/bridge/extension/**` structured error declarations.

## Callable browser tools

| Tool | Label | Group | Parameters | Actions / command surface | Artifact behavior | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `browser_artifact` | Browser Artifact | core | `columnLimit`, `columnOffset`, `contextChars`, `contextLines`, `glob`, `ignoreCase`, `jsonPath`, `limit`, `maxBytes`, `maxFiles`, `maxMatches`, `maxMatchesPerFile`, `maxTotalMatches`, `mode`, `offset`, `path`, `paths`, `pick`, `query`, `regex`, `root` | Read/search browser tool artifact files by path, offsets, snippets, JSON paths, or bounded multi-artifact search. | inline-only | `src/commands/defineArtifactCommand.ts` |
| `browser_callback_oast` | Browser Callback OAST | security | `action`, `afterSeq`, `basePath`, `body`, `bodyBase64`, `correlationId`, `dnsBaseDomain`, `dnsListenHost`, `dnsPort`, `dnsResponseAddress`, `enableDns`, `enableHttps`, `externalMetadata`, `httpsPort`, `listenHost`, `maxEvents`, `maxRuntimeMs`, `method`, `mode`, `port`, `publicBaseUrl`, `publicDnsBaseDomain`, `publicHttpsBaseUrl`, `queryName`, `queryType`, `rejectUnauthorized`, `requestHeaders`, `resolverHost`, `resolverPort`, `responseBody`, `responseHeaders`, `responseStatus`, `sessionId`, `target`, `targetRef`, `triggerTimeoutMs` | Start, inspect, trigger, collect, clear, or stop callback listener sessions for SSRF, blind injection, and deserialization evidence. | outputPath/artifact; callback-oast-<ts>.json | `src/commands/webSecurity/commands/registerCallbackOast.ts` |
| `browser_command` | Browser Command | core | `command`, `tabId`, `targetRef` | Send a bridge command object through the Browser Pilot bridge. | outputPath/artifact; command-<ts>.json | `src/commands/defineNativeCommand.ts` |
| `browser_cookie_analyze` | Browser Cookie Analyze | security | `allowPrivateTargets`, `bindBrowserSession`, `claimMutations`, `claimReplay`, `cookie`, `cookies`, `jwt`, `jwts`, `maxSecretCandidates`, `secretCandidates`, `secrets`, `setCookie`, `setCookies`, `tabId`, `targetRef`, `url`, `values`, `wordlist`, `wordlistPath` | Analyze cookies/JWT/session values, verify signing or decryption candidates, generate claim-mutation tokens, validate claim replays, and store structured evidence. | outputPath/artifact; cookie-analyze-<ts>.json | `src/commands/webSecurity/commands/registerCookieAnalyze.ts` |
| `browser_crawl` | Browser Crawl | security | `action`, `activeGraphqlIntrospection`, `allowPrivateTargets`, `bindBrowserSession`, `extractJs`, `headers`, `includeFaviconHash`, `includeTlsCertificate`, `knownFiles`, `method`, `paths`, `ports`, `sameOrigin`, `schemes`, `tabId`, `url`, `urls` | Collect scoped Web metadata through fingerprint probing or recursive crawl with structured evidence artifacts. | outputPath/artifact; crawl-fingerprint-<ts>.json | `src/commands/webSecurity/commands/registerCrawl.ts` |
| `browser_download` | Browser Download | core | `conflictAction`, `expectMime`, `filename`, `index`, `mode`, `saveAs`, `selector`, `tabId`, `targetRef`, `url` | Download via selector click, media selector extraction, or direct HTTP(S) URL; returns download id/path/state. | outputPath/artifact | `src/commands/transferCommands.ts` |
| `browser_evidence` | Browser Evidence | core | `eventTypes`, `includeHook`, `includeNetwork`, `includePerformance`, `params`, `sessionId`, `tabId`, `targetRef` | Collect native browser evidence across network/dom/console/error/storage/websocket/crypto/dom_sinks. | outputPath/artifact | `src/commands/defineEvidenceCommand.ts` |
| `browser_execute` | Browser Execute | core | `monitor`, `program`, `script`, `tabId`, `targetRef` | Execute JavaScript, or a structured program of physical input frames (mouse/key/text/drag) and JS eval, in a real browser tab. | outputPath/artifact; execute-<ts>.json | `src/commands/defineExecuteCommand.ts` |
| `browser_frame` | Browser Frame | core | `action`, `params`, `tabId`, `targetRef` | Inspect browser frames or evaluate JavaScript in a target frame. | outputPath/artifact; frame-result-<ts>.json | `src/commands/defineNativeActionCommands.ts` |
| `browser_fuzz` | Browser Fuzz | security | `allowPrivateTargets`, `appendSlash`, `baseDomain`, `baseUrl`, `baselineHost`, `baselineHosts`, `baselinePath`, `baselineStrategy`, `bindBrowserSession`, `body`, `bodyBase64`, `contentTypeVariants`, `extensions`, `filterBaseline`, `filterBodyBytes`, `filterStatus`, `headers`, `hosts`, `jsonValues`, `locations`, `matchStatus`, `method`, `mode`, `mutations`, `operations`, `paramNames`, `paths`, `rawRequest`, `recursive`, `request`, `sniMode`, `sniName`, `tabId`, `template`, `url`, `urls`, `values`, `wordlist`, `wordlistPath`, `words` | Run bounded path, vhost, or parameter fuzzing against explicit scoped HTTP targets with structured evidence. | outputPath/artifact; fuzz-vhosts-<ts>.json | `src/commands/webSecurity/commands/registerFuzz.ts` |
| `browser_hook` | Browser Hook | core | `action`, `params`, `tabId`, `sessionId`, `targetRef` | Install and collect native browser hooks for network/dom/console/error/storage/websocket/crypto/dom_sinks events. | outputPath/artifact; hook-result-<ts>.json | `src/commands/defineNativeActionCommands.ts` |
| `browser_http_replay` | Browser HTTP Replay | security | `allowPrivateTargets`, `baseUrl`, `bindBrowserSession`, `body`, `bodyBase64`, `compareBaseline`, `continueOnError`, `csrfCookie`, `csrfHeader`, `har`, `harEntryIndex`, `harPath`, `harUrlPattern`, `headers`, `method`, `multipart`, `mutations`, `rawRequest`, `reflectCsrf`, `request`, `requests`, `sequence`, `sequenceCookies`, `tabId`, `url`, `variableScope`, `variables` | Replay captured/raw HTTP requests, mutate method/headers/body, and store bounded response evidence artifacts. | outputPath/artifact; http-replay-<ts>.json | `src/commands/webSecurity/commands/registerHttpReplay.ts` |
| `browser_memory` | Browser Memory | core | `action`, `body`, `evidenceRefs`, `id`, `jsonPath`, `kind`, `limit`, `mode`, `offset`, `query`, `scopeKey`, `scopeKind`, `title`, `triggers`, `uri`, `url` | Record durable browser memory entries; browser_observe automatically surfaces matched memory in envelope.memory, while recall/read remain available for manual follow-up. | outputPath/artifact; browser-memory-read.json-<ts>.json | `src/commands/defineMemoryCommand.ts` |
| `browser_network` | Browser Network | core | `action`, `params`, `tabId`, `sessionId`, `targetRef` | Control Browser Network recorder and inspect captured requests/bodies/HAR. | outputPath/artifact; network-result-<ts>.json | `src/commands/defineNativeActionCommands.ts` |
| `browser_observe` | Browser Observe | core | `actionRef`, `baseline`, `baselinePath`, `baselineSnapshotId`, `diff`, `fresh`, `htmlMode`, `includeIframes`, `includeLinks`, `intent`, `maxNodes`, `mode`, `params`, `selector`, `tabId`, `targetRef`, `url` | Observe browser tabs, page structure, readable content, or exact HTML via an explicit observation mode. | outputPath/artifact | `src/commands/defineObserveCommand.ts` |
| `browser_pick` | Browser Pick | core | `focus`, `message`, `multiple`, `tabId`, `targetRef` | Ask the user to click elements in the browser; returns CSS selectors for selected elements. | outputPath/artifact; pick-<ts>.json | `src/commands/definePickCommand.ts` |
| `browser_screenshot` | Browser Screenshot | core | `captureBeyondViewport`, `fallback`, `format`, `quality`, `tabId`, `targetRef` | Capture a screenshot of the target browser tab and save it as an artifact file. | outputPath/artifact | `src/commands/defineScreenshotCommand.ts` |
| `browser_sqli` | Browser SQLi | security | `allowLauncherOverride`, `allowPrivateTargets`, `answers`, `banner`, `baseUrl`, `baselineRepeats`, `batch`, `bindBrowserSession`, `body`, `bodyBase64`, `booleanPayloadPairs`, `currentDb`, `currentUser`, `dbms`, `engine`, `errorPayloads`, `extraArgs`, `extractCharset`, `extractExpression`, `extractMaxLength`, `flushSession`, `har`, `harEntryIndex`, `harPath`, `harUrlPattern`, `headers`, `isDba`, `level`, `locations`, `method`, `mutations`, `orderByMax`, `paramNames`, `payloadMode`, `payloads`, `probeTypes`, `rawRequest`, `request`, `requests`, `retries`, `risk`, `sequence`, `sqlmapArgs`, `sqlmapPath`, `stopOnFirstMatch`, `tabId`, `tamper`, `targetRef`, `technique`, `threads`, `timePayloadWordlistPath`, `timePayloads`, `timeThresholdMs`, `unionColumnMax`, `unionEcho`, `unionPayloads`, `url`, `wordlistPath` | Probe SQL injection or run bounded sqlmap automation from explicit scoped request templates with structured evidence. | outputPath/artifact; sqlmap-bridge-<ts>.json | `src/commands/webSecurity/commands/registerSqli.ts` |
| `browser_tabs` | Browser Tabs | core | `action`, `active`, `allowExpired`, `browserId`, `browserSessionId`, `includeBridgePerTab`, `incognito`, `name`, `snapshotId`, `tabId`, `targetRef`, `url` | Control connected browser tabs. Common: list, snapshot, switch, create, close. Advanced (browser session & lease lifecycle — rarely needed): selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab. | outputPath/artifact | `src/commands/tabsCommand.ts` |
| `browser_template` | Browser Template | security | `allowLauncherOverride`, `allowPrivateTargets`, `authors`, `bindBrowserSession`, `body`, `bodyBase64`, `bulkSize`, `concurrency`, `engine`, `excludeTags`, `extraArgs`, `har`, `harEntryIndex`, `harPath`, `harUrlPattern`, `headers`, `maxRequests`, `method`, `mutations`, `nucleiArgs`, `nucleiPath`, `paths`, `rawRequest`, `request`, `requests`, `retries`, `sequence`, `severities`, `tabId`, `tags`, `targetRef`, `tech`, `templateIds`, `templatePath`, `templatePaths`, `templates`, `url`, `urls`, `variables`, `workflowPaths` | Run bounded built-in/custom HTTP template checks or mature nuclei template automation with structured evidence. | outputPath/artifact; nuclei-bridge-<ts>.json | `src/commands/webSecurity/commands/registerTemplate.ts` |
| `browser_upload` | Browser Upload | core | `confirm`, `files`, `index`, `selector`, `tabId`, `targetRef` | Click a file input/chooser selector and set absolute local file paths after explicit confirmation. | outputPath/artifact | `src/commands/transferCommands.ts` |
| `browser_wait` | Browser Wait | core | `action`, `params`, `tabId`, `sessionId`, `targetRef` | Run browser wait/navigation commands with typed action names. | outputPath/artifact; wait-result-<ts>.json | `src/commands/defineNativeActionCommands.ts` |

## Native bridge commands

| Command | Domain | Tab scoped | Methods | Required / method-required | Canonical |
| --- | --- | --- | --- | --- | --- |
| `batch` | core | no |  | commands |  |
| `bridge_wake` | core | no |  |  |  |
| `cdp` | core | yes |  | method |  |
| `contentSettings` | core | no |  |  |  |
| `cookies` | core | no |  |  |  |
| `management` | core | no | list, reload, disable, enable | disable:extId, enable:extId |  |
| `persistent_cdp` | core | yes |  |  |  |
| `tabs` | core | no | list, switch, create, close | switch:tabId, close:[targetTabId],[closeTabId],[tabId] |  |
| `evidence.collect` | evidence | yes |  |  |  |
| `frame.addNewDocumentScript` | frame | yes |  | source |  |
| `frame.evaluate` | frame | yes |  | frameId, expression |  |
| `frame.list` | frame | yes |  |  |  |
| `frame.removeNewDocumentScript` | frame | yes |  | identifier |  |
| `hook.addEventListener` | hook | yes |  | eventType |  |
| `hook.clear` | hook | yes |  |  | hook.clear_buffer |
| `hook.clear_buffer` | hook | yes |  |  |  |
| `hook.collect` | hook | yes |  |  |  |
| `hook.evaluate` | hook | yes |  | expression |  |
| `hook.getListenerChain` | hook | yes |  | selector |  |
| `hook.getNodeListeners` | hook | yes |  | selector |  |
| `hook.getPerformanceEntries` | hook | yes |  |  |  |
| `hook.getSinkHints` | hook | yes |  | selector |  |
| `hook.install` | hook | yes |  |  |  |
| `hook.install_targets` | hook | yes |  | targets |  |
| `hook.list_sessions` | hook | no |  |  |  |
| `hook.list_targets` | hook | no |  |  |  |
| `hook.pause` | hook | yes |  |  |  |
| `hook.removeEventListener` | hook | yes |  | listenerId |  |
| `hook.resume` | hook | yes |  |  |  |
| `hook.status` | hook | yes |  |  |  |
| `hook.uninstall` | hook | yes |  |  |  |
| `html.get` | html | yes |  |  |  |
| `input.keys` | input | yes |  | [text], [keys] |  |
| `input.pointer` | input | yes |  | gesture, x, y |  |
| `input.ref` | input | yes |  | action, target |  |
| `input.touch` | input | yes |  | gesture, x, y |  |
| `intercept.addRule` | intercept | yes |  | action |  |
| `intercept.collect` | intercept | yes |  |  |  |
| `intercept.continue` | intercept | yes |  | requestId |  |
| `intercept.fail` | intercept | yes |  | requestId |  |
| `intercept.fulfill` | intercept | yes |  | requestId |  |
| `intercept.install` | intercept | yes |  |  |  |
| `intercept.listRules` | intercept | yes |  |  |  |
| `intercept.pause` | intercept | yes |  | params |  |
| `intercept.removeRule` | intercept | yes |  | ruleId |  |
| `intercept.status` | intercept | yes |  |  |  |
| `intercept.uninstall` | intercept | yes |  |  |  |
| `network.body` | network | yes |  |  |  |
| `network.clear` | network | yes |  |  |  |
| `network.exportHar` | network | yes |  |  |  |
| `network.get` | network | yes |  |  |  |
| `network.list` | network | yes |  |  |  |
| `network.start` | network | yes |  |  |  |
| `network.status` | network | yes |  |  |  |
| `network.stop` | network | yes |  |  |  |
| `network.wait` | network | yes |  |  |  |
| `screenshot.capture` | screenshot | yes |  |  |  |
| `transfer.download` | transfer | yes |  | [selector], [url] |  |
| `transfer.upload` | transfer | yes |  | selector, files |  |
| `wait.all` | wait | yes |  |  |  |
| `wait.any` | wait | yes |  |  |  |
| `wait.cancel` | wait | yes |  |  |  |
| `wait.diagnose` | wait | yes |  |  |  |
| `wait.loadState` | wait | yes |  |  |  |
| `wait.navigate` | wait | yes |  | url |  |
| `wait.navigateAndWait` | wait | yes |  | url |  |
| `wait.navigation` | wait | yes |  |  |  |
| `wait.networkIdle` | wait | yes |  |  |  |
| `wait.selector` | wait | yes |  | selector |  |
| `ws.close` | ws | yes |  |  |  |
| `ws.collect` | ws | yes |  |  |  |
| `ws.open` | ws | yes |  | url |  |
| `ws.replay` | ws | yes |  | steps |  |
| `ws.send` | ws | yes |  | [text], [message] |  |
| `ws.status` | ws | yes |  |  |  |
| `ws.wait` | ws | yes |  |  |  |

## Structured error taxonomy

Generated taxonomy keeps public error codes stable and adds compact `taxonomy` / `diagnostics` fields to Node-side normalized error output.

| Code | Domain | Category | Retryable | Source | Local sources |
| --- | --- | --- | --- | --- | --- |
| `ACTIONABILITY_TIMEOUT` | abml | abml.actionability | yes | schema |  |
| `ALREADY_INSTALLED` | native | runtime.lifecycle | no | schema |  |
| `AMBIGUOUS_DOWNLOAD` | transfer | runtime.transfer | no | schema |  |
| `AMBIGUOUS_TAB_ID` | driver | driver.tab | no | schema | `src/bridge/server/BrowserTabSessionRouter.ts` |
| `ARTIFACT_JSON_INVALID` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_MULTI_SEARCH_MODE_INVALID` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_NOT_FOUND` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_PATH_REQUIRED` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_QUERY_REQUIRES_SEARCH_MODE` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_SEARCH_QUERY_REQUIRED` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_SEARCH_REGEX_INVALID` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_SEARCH_REGEX_UNSAFE` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ARTIFACT_TOO_LARGE` | artifact | tool.artifact | no | heuristic | `src/artifacts/artifactReader.ts` |
| `ATTACH_FAILED` | cdp | runtime.cdp | yes | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `BACKEND_NODE_STALE` | native | runtime.input | yes | schema | `src/bridge/extension/service_worker/input.ts` |
| `BACKEND_UNAVAILABLE` | abml | abml.backend | yes | schema | `src/kernels/abml/verbs/frame.ts`, `src/kernels/abml/verbs/pierce.ts`, `src/kernels/abml/verbs/read.ts`, `src/browser-runtime/abml/runtime.ts`, `src/browser-runtime/abml/visionRuntime.ts` |
| `BACKGROUND_THROTTLED` | page | runtime.page | yes | schema |  |
| `BODY_UNAVAILABLE` | network | runtime.network | no | schema |  |
| `BRIDGE_CLIENT_DISCONNECTED` | driver | driver.pending | yes | schema | `src/bridge/server/BrowserBridgePendingRequests.ts` |
| `BRIDGE_NOT_RUNNING` | driver | driver.lifecycle | yes | schema | `src/bridge/server/BrowserBridgeCommandService.ts` |
| `BRIDGE_SEND_FAILED` | driver | driver.pending | yes | schema | `src/bridge/server/BrowserBridgePendingRequests.ts` |
| `BRIDGE_START_FAILED` | driver | driver.lifecycle | yes | schema | `src/bridge/server/BrowserBridgeHttpServer.ts` |
| `BRIDGE_STOPPED` | driver | driver.pending | yes | schema | `src/bridge/server/BrowserBridgePendingRequests.ts` |
| `BRIDGE_TIMEOUT` | driver | driver.pending | yes | schema | `src/bridge/server/BrowserBridgePendingRequests.ts`, `src/commands/webSecurity/shared/http.ts` |
| `BROWSER_COMMAND_FAILED` | driver | driver.command | no | schema | `src/bridge/server/BrowserBridgeCommandService.ts`, `src/browser-command-runtime/waitSupervisor.ts`, `src/bridge/protocol/bridgeResultValidation.ts` |
| `BROWSER_EXECUTION_ERROR` | driver | driver.execution | no | schema | `src/bridge/server/BrowserBridgePendingRequests.ts`, `src/browser-page-runtime/pageScriptEvaluation.ts`, `src/commands/definePickCommand.ts` |
| `BROWSER_EXTENSION_RECONNECT_TIMEOUT` | driver | driver.lifecycle | yes | schema | `src/bridge/server/BrowserBridgeServer.ts`, `src/browser-command-runtime/waitSupervisor.ts` |
| `BROWSER_NOT_FOUND` | driver | driver.selection | no | schema | `src/bridge/server/BrowserBridgeServer.ts` |
| `BUFFER_OVERFLOW` | native | runtime.hook | no | schema |  |
| `CANCELLED` | native | runtime.wait | yes | schema |  |
| `CONTENT_EXTRACTION_FAILED` | tool | tool.content | no | schema |  |
| `CROSS_ORIGIN_BLOCKED` | abml | abml.backend | no | schema | `src/browser-runtime/abml/frameRuntime.ts` |
| `CROSS_ORIGIN_IFRAME` | page | runtime.frame | no | schema |  |
| `DETACH_FAILED` | cdp | runtime.cdp | yes | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `DOWNLOAD_TARGET_REQUIRED` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `ELEMENT_INDEX_OUT_OF_RANGE` | page | runtime.page | no | heuristic | `src/bridge/extension/service_worker/transfer.ts` |
| `ELEMENT_NOT_CLICKABLE` | page | runtime.page | no | heuristic | `src/bridge/extension/service_worker/transfer.ts` |
| `ELEMENT_NOT_FOUND` | page | runtime.page | yes | schema | `src/bridge/extension/service_worker/transfer.ts` |
| `EVENT_SUBSCRIPTION_FAILED` | native | runtime.hook | yes | schema |  |
| `FRAME_DETACHED` | page | runtime.frame | yes | schema |  |
| `FRAME_EVAL_FAILED` | cdp | runtime.cdp | yes | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `FRAME_NOT_FOUND` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `HANDLE_ETAG_MISMATCH` | abml | abml.ref | yes | schema | `src/kernels/refs/refPolicy.ts` |
| `HANDLE_EXPIRED` | abml | abml.ref | yes | schema | `src/kernels/refs/refPolicy.ts`, `src/adapters/resources-fs/resourceStore.ts` |
| `HANDLE_KIND_MISMATCH` | abml | abml.input | no | schema |  |
| `HANDLE_NOT_FOUND` | abml | abml.ref | yes | schema | `src/kernels/refs/refPolicy.ts`, `src/adapters/resources-fs/resourceStore.ts` |
| `HTTPS_CERT_GENERATION_FAILED` | security | tool.security | no | schema |  |
| `INJECTION_FAILED` | native | runtime.hook | yes | schema |  |
| `INTERNAL_ERROR` | native | runtime.internal | no | schema | `src/commands/webSecurity/shared/http.ts` |
| `INVALID_BROWSER_COMMAND` | protocol | driver.command | no | schema | `src/bridge/server/BrowserBridgeCommandService.ts`, `src/validation/middleware.ts` |
| `INVALID_BROWSER_ID` | driver | driver.selection | no | schema | `src/bridge/server/BrowserBridgeServer.ts` |
| `INVALID_INPUT` | abml | abml.input | no | schema | `src/browser-runtime/abml/pierceRuntime.ts`, `src/browser-runtime/abml/runtime.ts`, `src/browser-runtime/abml/visionRuntime.ts` |
| `INVALID_REF_TARGET` | native | runtime.input | no | schema |  |
| `INVALID_RULE` | tool | tool.validation | no | schema | `src/commands/observe/baseline.ts`, `src/commands/nativeCommand.ts`, `src/commands/executeCommand.ts`, `src/commands/observeCommand.ts`, `src/commands/pickCommand.ts`, `src/commands/tabsCommand.ts`, `src/commands/transferValidation.ts`, `src/commands/webSecurity/browserNative/callbackOast.ts`, `src/commands/webSecurity/browserNative/cookieAnalyze.ts`, `src/commands/webSecurity/browserNative/fuzzParams.ts`, `src/commands/webSecurity/browserNative/fuzzPaths.ts`, `src/commands/webSecurity/browserNative/fuzzVhosts.ts`, `src/commands/webSecurity/browserNative/httpReplay.ts`, `src/commands/webSecurity/browserNative/sqliProbe.ts`, `src/commands/webSecurity/browserNative/templateCheck.ts`, `src/commands/webSecurity/commands/shared.ts`, `src/commands/webSecurity/shared/har.ts`, `src/commands/webSecurity/shared/http.ts`, `src/commands/webSecurity/shared/normalize.ts`, `src/commands/webSecurity/shared/replay.ts`, `src/commands/webSecurity/shared/requestTemplate.ts`, `src/commands/webSecurity/shared/wsShell.ts` |
| `INVALID_SELECTOR` | page | runtime.selector | no | schema | `src/bridge/extension/service_worker/transfer.ts` |
| `INVALID_SESSION` | native | runtime.session | no | schema |  |
| `INVALID_TAB_ID` | driver | driver.tab | no | schema | `src/bridge/server/BrowserBridgeCommandService.ts`, `src/bridge/server/BrowserBridgeServer.ts` |
| `INVALID_TAB_URL` | tool | tool.tabs | no | schema | `src/commands/tabsCommand.ts` |
| `INVALID_TIMEOUT` | tool | tool.validation | no | schema | `src/commands/observe/common.ts` |
| `MATURE_BRIDGE_LAUNCHER_NOT_FOUND` | security | tool.security | no | schema |  |
| `MATURE_BRIDGE_LAUNCHER_OVERRIDE_REQUIRED` | security | tool.security | no | schema |  |
| `MATURE_BRIDGE_LAUNCHER_PROBE_FAILED` | security | tool.security | no | schema |  |
| `MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT` | security | tool.security | yes | schema |  |
| `MATURE_BRIDGE_LAUNCH_FAILED` | security | tool.security | no | schema |  |
| `MATURE_BRIDGE_PROCESS_TIMEOUT` | security | tool.security | yes | schema |  |
| `MATURE_BRIDGE_TARGET_REQUIRED` | security | tool.security | no | schema |  |
| `MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED` | security | tool.security | no | schema |  |
| `MEDIA_URL_NOT_FOUND` | page | runtime.page | no | heuristic | `src/bridge/extension/service_worker/transfer.ts` |
| `MEMORY_ACTION_UNSUPPORTED` | tool | tool.memory | no | schema | `src/commands/defineMemoryCommand.ts` |
| `MEMORY_ENTRY_NOT_FOUND` | tool | tool.memory | no | schema | `src/commands/memory/reader.ts` |
| `MEMORY_EVIDENCE_REQUIRED` | tool | tool.memory | no | schema |  |
| `MEMORY_EVIDENCE_STALE` | tool | tool.memory | no | schema | `src/resources/browserResultEvidence.ts`, `src/commands/memory/evidence.ts` |
| `MEMORY_EVIDENCE_UNREADABLE` | tool | tool.memory | no | schema | `src/commands/memory/evidence.ts` |
| `MEMORY_EVIDENCE_UNRESOLVABLE` | tool | tool.memory | no | schema | `src/resources/browserResultEvidence.ts`, `src/commands/memory/evidence.ts` |
| `MEMORY_RESOURCE_STALE` | tool | tool.memory | no | schema | `src/commands/memory/reader.ts` |
| `MEMORY_SCHEMA_INVALID` | tool | tool.memory | no | schema | `src/commands/memory/evidence.ts`, `src/memory/frontmatter.ts`, `src/memory/ids.ts`, `src/memory/indexStore.ts`, `src/commands/memory/origin.ts`, `src/commands/memory/reader.ts` |
| `MEMORY_SCOPE_REQUIRED` | tool | tool.memory | no | schema | `src/commands/memory/evidence.ts` |
| `MEMORY_SECRET_DETECTED` | tool | tool.memory | no | schema | `src/commands/memory/evidence.ts` |
| `NAVIGATION_TIMEOUT` | native | runtime.wait | yes | schema |  |
| `NETWORK_IDLE_TIMEOUT` | native | runtime.wait | yes | schema |  |
| `NETWORK_RECORDER_NOT_STARTED` | network | runtime.network | yes | schema |  |
| `NETWORK_RECORDER_TIMEOUT` | network | runtime.network | yes | schema |  |
| `NOT_INSTALLED` | native | runtime.session | yes | schema |  |
| `NO_BROWSER_EXTENSION` | driver | driver.lifecycle | yes | schema | `src/bridge/protocol/errors.ts` |
| `NO_IDENTIFIER` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `NO_METHOD` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `NO_SESSION` | native | runtime.session | yes | schema |  |
| `NO_SOURCE` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `NO_TAB` | driver | driver.tab | yes | schema | `src/browser-runtime/abml/runtime.ts`, `src/bridge/server/BrowserBridgeCommandService.ts`, `src/bridge/server/BrowserBridgeServer.ts` |
| `NO_TAB_ID` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `NO_TARGET_ID` | unknown | unknown | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `OOPIF_SESSION_UNSUPPORTED` | native | runtime.input | no | schema |  |
| `BROWSER_PILOT_CLICK_BINDING_UNAVAILABLE` | native | runtime.input | yes | schema | `src/browser-command-runtime/executeStdlibPrelude.ts` |
| `BROWSER_PILOT_CLICK_CANCELLED` | native | runtime.input | yes | schema | `src/browser-command-runtime/executeStdlibPrelude.ts` |
| `BROWSER_PILOT_CLICK_REF_NOT_RESOLVED` | native | runtime.input | yes | schema | `src/browser-command-runtime/executeStdlibPrelude.ts` |
| `BROWSER_PILOT_CLICK_TIMEOUT` | native | runtime.input | yes | schema | `src/browser-command-runtime/executeStdlibPrelude.ts` |
| `PRIVACY_BLOCKED` | abml | abml.privacy | no | schema | `src/kernels/refs/refPolicy.ts` |
| `PRIVATE_TARGET_BLOCKED` | security | tool.security | no | schema | `src/commands/webSecurity/shared/http.ts` |
| `QUEUE_FULL` | driver | driver.queue | yes | schema | `src/bridge/server/BrowserCommandQueueRegistry.ts` |
| `REF_AMBIGUOUS` | abml | abml.ref | yes | schema |  |
| `REF_NOT_FOUND` | abml | abml.ref | yes | schema |  |
| `REF_SCOPE_VIOLATION` | abml | abml.session | yes | schema | `src/kernels/refs/refPolicy.ts` |
| `REF_STALE` | abml | abml.ref | yes | schema | `src/kernels/refs/refPolicy.ts`, `src/adapters/resources-fs/resourceStore.ts` |
| `REQUEST_NOT_FOUND` | network | runtime.network | no | schema |  |
| `RESOURCE_NOT_FOUND` | abml | abml.ref | no | schema | `src/adapters/resources-fs/resourceReader.ts` |
| `RESOURCE_READ_ERROR` | abml | abml.ref | no | schema | `src/adapters/resources-fs/resourceReader.ts` |
| `RESOURCE_STALE` | abml | abml.ref | yes | schema | `src/adapters/resources-fs/resourceReader.ts` |
| `RUNTIME_STATE_LOST` | native | runtime.recovery | yes | schema |  |
| `RUNTIME_STATE_RECOVERED` | native | runtime.recovery | yes | schema |  |
| `RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS` | native | runtime.recovery | yes | schema |  |
| `SAFETY_BLOCKED` | transfer | runtime.transfer | no | schema |  |
| `SCRIPT_NOT_FOUND` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `SELECTOR_NOT_FOUND` | page | runtime.selector | yes | schema |  |
| `SELECTOR_TIMEOUT` | page | runtime.selector | yes | schema |  |
| `SEND_FAILED` | cdp | runtime.cdp | yes | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `SESSION_LIMIT` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `SESSION_NOT_FOUND` | native | runtime.session | yes | schema | `src/kernels/session/sessionRegistry.ts` |
| `TAB_CRASHED` | page | runtime.tab | yes | schema |  |
| `TAB_ID_CONFLICT` | driver | driver.tab | no | schema | `src/bridge/server/BrowserBridgeCommandService.ts` |
| `TAB_ID_REQUIRED` | tool | tool.tabs | no | schema | `src/commands/tabsCommand.ts` |
| `TAB_LEASE_CONFLICT` | driver | driver.lease | no | schema | `src/bridge/server/BrowserBridgeCommandService.ts`, `src/kernels/session/leaseRegistry.ts` |
| `TAB_NOT_FOUND` | driver | driver.tab | yes | schema | `src/bridge/protocol/errors.ts` |
| `TARGET_ATTACH_FAILED` | cdp | runtime.cdp | yes | schema | `src/bridge/extension/service_worker/cdp.ts` |
| `TARGET_DETACH_FAILED` | unknown | unknown | yes | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `TARGET_DISABLED` | abml | abml.actionability | yes | schema |  |
| `TARGET_NOT_EDITABLE` | abml | abml.actionability | no | schema |  |
| `TARGET_OCCLUDED` | abml | abml.actionability | yes | schema |  |
| `TIMEOUT` | native | runtime.timeout | yes | schema | `src/commands/webSecurity/browserNative/sqliProbe.ts` |
| `UI_LOCK_CONFLICT` | driver | driver.lease | no | schema | `src/kernels/session/leaseRegistry.ts` |
| `UNKNOWN_ACTION` | cdp | runtime.cdp | no | heuristic | `src/bridge/extension/service_worker/cdp.ts` |
| `UNKNOWN_BROWSER_CLIENT` | driver | driver.selection | no | schema | `src/bridge/server/BrowserBridgeClientRegistry.ts` |
| `UNSUPPORTED_SCOPE_KIND` | tool | tool.memory | no | schema |  |
| `UNSUPPORTED_TARGET` | transfer | runtime.transfer | no | schema |  |
| `UPLOAD_CONFIRMATION_REQUIRED` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_FILES_LIMIT` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_FILES_REQUIRED` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_FILE_NOT_FOUND` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_PATH_NOT_ABSOLUTE` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_PATH_NOT_FILE` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_REQUIRES_BROWSER_UPLOAD` | transfer | tool.transfer | no | schema | `src/commands/transferValidation.ts` |
| `UPLOAD_SELECTOR_REQUIRED` | transfer | tool.transfer | no | schema | `src/commands/transferCommands.ts` |
| `VERIFY_FAILED` | abml | abml.verification | yes | schema |  |
| `VERIFY_INCONCLUSIVE` | abml | abml.verification | yes | schema |  |
| `WAIT_STATE_LOST` | driver | driver.wait | yes | schema |  |
| `WAIT_TIMEOUT` | driver | driver.wait | yes | schema | `src/browser-command-runtime/waitSupervisor.ts` |
| `WEBSOCKET_INVALID_INPUT` | websocket | bridge.ws | no | schema |  |
| `WEBSOCKET_INVALID_MATCHER` | websocket | bridge.ws | no | schema |  |
| `WEBSOCKET_OPEN_FAILED` | websocket | bridge.ws | yes | schema |  |
| `WEBSOCKET_OPEN_TIMEOUT` | websocket | bridge.ws | yes | schema |  |
| `WEBSOCKET_SEND_FAILED` | websocket | bridge.ws | yes | schema |  |
| `WEBSOCKET_SESSION_ALREADY_OPEN` | websocket | bridge.ws | no | schema |  |
| `WEBSOCKET_SESSION_NOT_FOUND` | websocket | bridge.ws | no | schema |  |
| `WEBSOCKET_SESSION_NOT_OPEN` | websocket | bridge.ws | no | schema |  |
| `WEBSOCKET_WAIT_ABORTED` | websocket | bridge.ws | yes | schema |  |
| `WEBSOCKET_WAIT_TIMEOUT` | websocket | bridge.ws | yes | schema |  |
| `WORDLIST_PATH_BLOCKED` | security | tool.security | no | schema | `src/commands/webSecurity/shared/normalize.ts` |

## Artifact and privacy contract

- Tools exposing `outputPath` or result middleware preserve full evidence in local artifacts while summaries stay compact.
- Saved artifacts are classified as local raw evidence under `.browser-pilot/artifacts/`; cleanup is manual and local-only.
- `browser_artifact` redacts text/search/sample and whole-JSON output by default; explicit `jsonPath`/`pick` reads return the named local raw value.
- WebSecurity commands use bounded local artifacts and shared distillation helpers; raw evidence stays local.
- Lifecycle fixture failure evidence is written to `.browser-pilot/artifacts/lifecycle-fixture-failure.json` with cookie/token/authorization/body/postData-style fields redacted by key.
