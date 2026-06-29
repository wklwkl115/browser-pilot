import { artifactPath, asArray, bridgeArtifacts, hostOf, increment, isRecord, redactSensitiveSummaryTextValue, redactSensitiveSummaryValue, summaryTable, topCounts, type Summary } from "./shared.js";

export function summarizeSqlmapBridgeData(value: unknown): Summary {
	const runs = isRecord(value) ? asArray(value.runs).filter(isRecord) : [];
	const findings = isRecord(value) ? asArray(value.findings).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const artifacts = redactSensitiveSummaryValue(bridgeArtifacts(value, runs));
	const dbmsCounts: Record<string, number> = {};
	const parameterCounts: Record<string, number> = {};
	for (const item of findings) {
		if (Array.isArray(item.dbmsFingerprints)) for (const dbms of item.dbmsFingerprints) increment(dbmsCounts, dbms);
		increment(parameterCounts, item.parameter ?? "unknown");
	}
	for (const run of runs) {
		if (Array.isArray(run.dbmsFingerprints)) for (const dbms of run.dbmsFingerprints) increment(dbmsCounts, dbms);
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		runCount: runs.length,
		targetCount: isRecord(value) ? value.targetCount : undefined,
		vulnerableRunCount: isRecord(value) ? value.vulnerableRunCount : undefined,
		findingCount: findings.length,
		failureCount: failures.length,
		launcher: isRecord(value) ? value.launcher : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		artifactCount: artifacts.length,
		dbmsFingerprints: isRecord(value) ? value.dbmsFingerprints : undefined,
		currentUsers: isRecord(value) ? value.currentUsers : undefined,
		currentDatabases: isRecord(value) ? value.currentDatabases : undefined,
		dbmsCounts: topCounts(dbmsCounts),
		parameterCounts: topCounts(parameterCounts),
		artifacts: summaryTable(artifacts, [
			{ key: "kind", value: (item) => item.kind },
			{ key: "label", value: (item) => item.label },
			{ key: "path", value: (item) => item.path },
			{ key: "bytes", value: (item) => item.bytes },
			{ key: "lines", value: (item) => item.lineCount },
			{ key: "sha256", value: (item) => item.sha256 },
		], 30),
		runs: summaryTable(runs, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "url", value: (item) => redactSensitiveSummaryTextValue(item.targetUrl) },
			{ key: "exitCode", value: (item) => item.exitCode },
			{ key: "durationMs", value: (item) => item.durationMs },
			{ key: "vulnerable", value: (item) => item.vulnerable },
			{ key: "findings", value: (item) => item.findingCount },
			{ key: "dbms", value: (item) => item.dbmsFingerprints },
			{ key: "currentDb", value: (item) => item.currentDatabase },
			{ key: "currentUser", value: (item) => item.currentUser },
			{ key: "isDba", value: (item) => item.isDba },
			{ key: "stdoutArtifact", value: (item) => artifactPath(item.stdoutArtifact) },
			{ key: "stderrArtifact", value: (item) => artifactPath(item.stderrArtifact) },
			{ key: "outputDir", value: (item) => item.outputDir },
		], 20),
		findings: summaryTable(findings, [
			{ key: "run", value: (item) => item.runIndex },
			{ key: "url", value: (item) => redactSensitiveSummaryTextValue(item.targetUrl) },
			{ key: "param", value: (item) => item.parameter },
			{ key: "place", value: (item) => item.place },
			{ key: "type", value: (item) => item.type },
			{ key: "title", value: (item) => item.title },
			{ key: "payload", value: (item) => redactSensitiveSummaryTextValue(item.payload) },
		], 30),
		failures: summaryTable(failures, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "error", value: (item) => redactSensitiveSummaryTextValue(item.error) },
		], 10),
		nextActions: [
			"read stdout, stderr, or request artifacts with browser_artifact before broadening sqlmap scope",
			"use browser_http_replay to verify a specific vulnerable request variant outside the mature bridge",
			"narrow paramNames, technique, level, risk, or target sequence before rerunning deeper SQLi automation",
		],
	};
}
export function summarizeNucleiBridgeData(value: unknown): Summary {
	const runs = isRecord(value) ? asArray(value.runs).filter(isRecord) : [];
	const matches = isRecord(value) ? asArray(value.matches).filter(isRecord) : [];
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const artifacts = redactSensitiveSummaryValue(bridgeArtifacts(value, runs));
	const severityCounts: Record<string, number> = {};
	const templateCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	for (const item of matches) {
		increment(severityCounts, item.severity ?? "unknown");
		increment(templateCounts, item.templateId ?? "unknown");
		increment(hostCounts, hostOf(item.matchedAt ?? item.host ?? item.targetUrl));
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		runCount: runs.length,
		targetCount: isRecord(value) ? value.targetCount : undefined,
		matchedRunCount: isRecord(value) ? value.matchedRunCount : undefined,
		matchCount: matches.length,
		failureCount: failures.length,
		parseErrorCount: isRecord(value) ? value.parseErrorCount : undefined,
		launcher: isRecord(value) ? value.launcher : undefined,
		artifactRoot: isRecord(value) ? value.artifactRoot : undefined,
		artifactCount: artifacts.length,
		matchedTemplateIds: isRecord(value) ? value.matchedTemplateIds : undefined,
		matchedSeverities: isRecord(value) ? value.matchedSeverities : undefined,
		selectedTemplatePaths: isRecord(value) ? value.selectedTemplatePaths : undefined,
		selectedWorkflowPaths: isRecord(value) ? value.selectedWorkflowPaths : undefined,
		selectedTemplateIds: isRecord(value) ? value.selectedTemplateIds : undefined,
		selectedTags: isRecord(value) ? value.selectedTags : undefined,
		selectedExcludeTags: isRecord(value) ? value.selectedExcludeTags : undefined,
		selectedSeverities: isRecord(value) ? value.selectedSeverities : undefined,
		selectedAuthors: isRecord(value) ? value.selectedAuthors : undefined,
		severityCounts: topCounts(severityCounts),
		templateCounts: topCounts(templateCounts),
		hostCounts: topCounts(hostCounts),
		artifacts: summaryTable(artifacts, [
			{ key: "kind", value: (item) => item.kind },
			{ key: "label", value: (item) => item.label },
			{ key: "path", value: (item) => item.path },
			{ key: "bytes", value: (item) => item.bytes },
			{ key: "lines", value: (item) => item.lineCount },
			{ key: "sha256", value: (item) => item.sha256 },
		], 30),
		runs: summaryTable(runs, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "url", value: (item) => redactSensitiveSummaryTextValue(item.targetUrl) },
			{ key: "exitCode", value: (item) => item.exitCode },
			{ key: "durationMs", value: (item) => item.durationMs },
			{ key: "matched", value: (item) => item.matched },
			{ key: "matches", value: (item) => item.matchCount },
			{ key: "severities", value: (item) => item.matchSeverities },
			{ key: "templateIds", value: (item) => item.matchTemplateIds },
			{ key: "stdoutArtifact", value: (item) => artifactPath(item.stdoutArtifact) },
			{ key: "stderrArtifact", value: (item) => artifactPath(item.stderrArtifact) },
			{ key: "outputDir", value: (item) => item.outputDir },
		], 20),
		matches: summaryTable(matches, [
			{ key: "run", value: (item) => item.runIndex },
			{ key: "url", value: (item) => redactSensitiveSummaryTextValue(item.targetUrl) },
			{ key: "templateId", value: (item) => item.templateId },
			{ key: "name", value: (item) => item.templateName },
			{ key: "severity", value: (item) => item.severity },
			{ key: "matchedAt", value: (item) => redactSensitiveSummaryTextValue(item.matchedAt) },
			{ key: "matcher", value: (item) => item.matcherName },
			{ key: "extractor", value: (item) => item.extractorName },
			{ key: "extracts", value: (item) => Array.isArray(item.extractedResults) ? redactSensitiveSummaryValue(item.extractedResults.slice(0, 4)) : undefined },
			{ key: "requestPreview", value: (item) => redactSensitiveSummaryTextValue(item.requestPreview) },
		], 30),
		failures: summaryTable(failures, [
			{ key: "index", value: (item) => item.index },
			{ key: "source", value: (item) => item.source },
			{ key: "error", value: (item) => redactSensitiveSummaryTextValue(item.error) },
		], 10),
		nextActions: [
			"read nuclei stdout, stderr, or jsonl artifacts with browser_artifact before widening template scope",
			"use browser_http_replay to manually verify a matched request or extracted exposure path",
			"narrow templatePaths, workflowPaths, templateIds, tags, severities, or authors before rerunning nuclei",
		],
	};
}
