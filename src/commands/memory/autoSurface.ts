import { stat } from "node:fs/promises";
import type { DistilledEnvelope } from "../resultMiddleware.js";
import type { MemoryIndex } from "../../memory/types.js";
import { EMPTY_MEMORY_INDEX, readMemoryIndexNoRepair } from "../../memory/indexStore.js";
import { resolveMemoryPath } from "../../memory/paths.js";
import { normalizeOriginKeyFromUrl } from "./origin.js";
import { memoryKernelEnabled } from "../../memory/secret.js";

// Tools that never carry a single page origin worth surfacing memory against, or
// where surfacing would be self-referential noise.
const SKIP_TOOLS = new Set(["browser_memory", "browser_tabs"]);
// Read-only/observational tools still surface RECALL hints, but never trigger the
// record nudge: merely looking at a page is not a reusable accomplishment worth
// crystallizing into an SOP — only acting on it is.
const NON_SALIENT_RECORD_TOOLS = new Set(["browser_observe", "browser_screenshot", "browser_wait", "browser_frame", "browser_pick", "browser_artifact"]);
const WARNED_AUTOMATIC_INDEX_READ_CAP = 2000;
const warnedAutomaticIndexReads = new Set<string>();

// Origins already nudged to record this process, keyed by `${cwd}::${origin}`.
// Bounds the write-side nudge to once per uncovered origin per session so a
// declined suggestion does not nag on every subsequent durable result. Capped so
// a long-lived server visiting many origins cannot grow it without bound (on
// overflow it resets — a re-nudge after thousands of origins is harmless).
const RECORD_SUGGESTED_CAP = 2000;
const recordSuggested = new Set<string>();

// Test hook: clear session-scoped record-suggestion memory.
export function __resetMemoryAutoSurfaceState(): void {
	recordSuggested.clear();
	warnedAutomaticIndexReads.clear();
}

// Read the derived index fresh on every call. The file is tiny and command results
// are agent-paced, so a single read is cheaper than the staleness it removes:
// a process-lifetime cache made freshly recorded memory invisible until restart.
// When no index.json exists no memory was ever recorded — return empty without
// materializing the file (avoids creating .browser-pilot/memory/ for non-users).
export async function loadMemoryIndex(cwd?: string): Promise<MemoryIndex> {
	const indexPath = resolveMemoryPath(cwd, "index.json");
	const exists = await stat(indexPath).then(() => true).catch(() => false);
	if (!exists) return EMPTY_MEMORY_INDEX;
	return (await readMemoryIndexNoRepair(cwd)).index;
}

async function loadMemoryIndexForAutoSurface(cwd?: string): Promise<{ index: MemoryIndex; warning?: string }> {
	const indexPath = resolveMemoryPath(cwd, "index.json");
	const exists = await stat(indexPath).then(() => true).catch(() => false);
	if (!exists) return { index: EMPTY_MEMORY_INDEX };
	const result = await readMemoryIndexNoRepair(cwd);
	if (!result.warning) return result;
	const warningKey = `${cwd || ""}\u0000${result.warning}`;
	if (warnedAutomaticIndexReads.has(warningKey)) return { index: result.index };
	if (warnedAutomaticIndexReads.size >= WARNED_AUTOMATIC_INDEX_READ_CAP) warnedAutomaticIndexReads.clear();
	warnedAutomaticIndexReads.add(warningKey);
	return result;
}

function withDiagnosticWarning(envelope: DistilledEnvelope, warning: string | undefined): DistilledEnvelope {
	if (!warning) return envelope;
	const diagnostics = { ...(envelope.diagnostics ?? {}) };
	const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.filter((item): item is string => typeof item === "string") : [];
	if (!warnings.includes(warning)) warnings.push(warning);
	diagnostics.warnings = warnings;
	return { ...envelope, diagnostics };
}

function collectStrings(record: Record<string, unknown> | undefined, keys: string[]): string[] {
	if (!record) return [];
	const out: string[] = [];
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value) out.push(value);
	}
	return out;
}

function pageContext(envelope: DistilledEnvelope): { origin?: string; url?: string } {
	const urls = [
		...collectStrings(envelope.summary, ["url"]),
		...collectStrings(envelope.target, ["url"]),
		...collectStrings(envelope.snapshot, ["url"]),
	];
	let origin: string | undefined;
	let originUrl: string | undefined;
	for (const url of urls) {
		try { origin = normalizeOriginKeyFromUrl(url); originUrl = url; break; } catch { /* try next url */ }
	}
	return { origin, url: originUrl };
}

// A durable, citable evidence path already present on the result — exactly what
// `browser_memory record` needs as an evidenceRef. Its presence also gates the
// nudge hint when one is available — evidence is optional, but citing it is handy.
function durableEvidencePath(envelope: DistilledEnvelope): string | undefined {
	const saved = envelope.saved;
	if (saved && typeof saved.path === "string" && saved.path) return saved.path;
	const snapshotSaved = envelope.snapshot?.saved as Record<string, unknown> | undefined;
	if (snapshotSaved && typeof snapshotSaved.path === "string" && snapshotSaved.path) return snapshotSaved.path;
	return undefined;
}

function recordHint(url: string, evidencePath: string | undefined): string {
	const evidence = evidencePath ? ` evidenceRefs=["${evidencePath}"]` : "";
	return `record candidate: if you finished a reusable task here, crystallize it — browser_memory action=record kind=sop scopeKind=origin url=${url}${evidence}`;
}

export async function appendMemoryAutoSurface(options: { cwd?: string; envelope: DistilledEnvelope }): Promise<DistilledEnvelope> {
	if (!memoryKernelEnabled()) return options.envelope;
	if (process.env["BROWSER_PILOT_MEMORY_AUTOSURFACE"] === "0") return options.envelope;
	const { envelope } = options;
	if (SKIP_TOOLS.has(envelope.tool)) return options.envelope;
	if (envelope.summary?.mode === "tabs") return options.envelope;
	const { origin, url } = pageContext(envelope);
	if (!origin) return options.envelope;
	const loadedIndex = await loadMemoryIndexForAutoSurface(options.cwd);
	const index = loadedIndex.index;

	const nextActions = Array.isArray(envelope.nextActions) ? [...envelope.nextActions] : [];
	const before = nextActions.length;

	// Record side: when this origin has no SOP/fact yet, nudge crystallization once
	// per origin per session after a "doing" tool — GA-style, evidence is optional,
	// so a successful task can be crystallized without a saved artifact. This is the
	// write-loop ignition the recall side alone cannot start.
	if (origin && url && !NON_SALIENT_RECORD_TOOLS.has(envelope.tool)) {
		const originCovered = index.entries.some((entry) => entry.scopeKind === "origin" && entry.scopeKey === origin && entry.status === "active");
		const recordKey = `${options.cwd || ""}::${origin}`;
		if (!originCovered && !recordSuggested.has(recordKey)) {
			if (recordSuggested.size >= RECORD_SUGGESTED_CAP) recordSuggested.clear();
			recordSuggested.add(recordKey);
			nextActions.push(recordHint(url, durableEvidencePath(envelope)));
		}
	}

	const out = nextActions.length > before ? { ...envelope, nextActions } : options.envelope;
	return withDiagnosticWarning(out, loadedIndex.warning);
}
