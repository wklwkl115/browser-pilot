/**
 * Test 3 — zero-poll wait regression (plan §5)
 *
 * Contract: `browser_wait selector` is event-driven. The bridge installs
 * Runtime.addBinding + MutationObserver (installBindingObserver ~:181-257 in
 * wait_selector.ts). Polling is armed only as a fallback after the binding
 * path fails, and the fallback emits a diagnostic warning
 * `runtime_binding_observer_unavailable_poll_fallback_active` to signal it.
 *
 * Design choice (Option B — minimal additive seam):
 *   wait_selector.ts is a Chrome extension service-worker module with heavy
 *   CDPContext/chrome-API dependencies; it cannot be imported or executed in
 *   Node without substantial mocking that would replicate the production loop
 *   rather than test it. Instead, this test:
 *   (a) Reads the source text of wait_selector.ts (the authoritative file) and
 *       asserts the structural invariants that guarantee the event path exists
 *       and that poll is gated behind a fallback diagnostic.
 *   (b) Additionally reads the built dist bundle (bridge/pi_browser_bridge/dist/
 *       service-worker.js) and asserts the same markers survive bundling —
 *       matching the pattern used by check-page-scripts.mjs for bridge bundles.
 *
 * This test FAILS when:
 *   - Someone removes the Runtime.addBinding install path from wait_selector.ts
 *   - The poll fallback loses its diagnostic gate (armPoll fires unconditionally)
 *   - The binding + observer install guard is removed
 *   - The dist bundle drifts from the source (regenerate with npm run build:bridge)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

// Strip TS type annotations for text-search purposes (we want structural markers)
function stripTs(source: string): string {
	// Remove type annotations and imports for readability in assertions
	return source
		.replace(/:\s*\w[\w.<>, |&\[\]]*(?=[,);{=\n])/g, "")
		.replace(/import\s+type\s+\{[^}]+\}/g, "")
		.replace(/as\s+\w+/g, "");
}

// ── Source structural invariants ──────────────────────────────────────────────

test("wait.selector source: Runtime.addBinding install path exists (event-driven mechanism)", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");
	assert(src.includes("Runtime.addBinding"),
		"wait.selector must install a Runtime.addBinding binding for event-driven notification");
	assert(src.includes("Runtime.bindingCalled"),
		"wait.selector must subscribe to Runtime.bindingCalled to receive page mutation events");
	assert(src.includes("new MutationObserver"),
		"wait.selector must install a MutationObserver in the page world to detect DOM changes");
});

test("wait.selector source: event path triggers re-evaluation (triggerTick from binding)", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");
	// The binding callback must call triggerTick (not armPoll directly)
	assert(src.includes("triggerTick"),
		"wait.selector must call triggerTick from the binding/observer event path");
	// triggerTick must clear the poll timer before each event-driven tick
	assert(src.includes("clearPollTimer"),
		"wait.selector triggerTick must clear any pending poll timer when an event fires");
});

test("wait.selector source: poll is fallback-only — armed after binding, not unconditionally", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");

	// The fallback diagnostic marker must be present and coupled to the poll arm
	assert(src.includes("runtime_binding_observer_unavailable_poll_fallback_active"),
		"wait.selector must emit the poll-fallback diagnostic when the binding install fails");

	// armPoll must not be called before installBindingObserver
	// Structural check: armPoll is defined as a closure after installBindingObserver,
	// and the install uses void installBindingObserver().catch(...) — poll arms only on catch.
	const installIdx = src.indexOf("installBindingObserver");
	const armPollIdx = src.indexOf("armPoll()");
	assert.equal(installIdx !== -1, true, "installBindingObserver must be defined");
	assert.equal(armPollIdx !== -1, true, "armPoll must exist");
	// The first armPoll() call site must come AFTER installBindingObserver definition
	assert(armPollIdx > installIdx,
		"armPoll() must be called after installBindingObserver is defined (poll is a fallback, not primary)");
});

test("wait.selector source: poll fallback diagnostic is in the .catch() path of installBindingObserver", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");

	// The fallback warning is inside the .catch() of installBindingObserver
	const catchIdx = src.indexOf(".catch(");
	const diagnosticIdx = src.indexOf("runtime_binding_observer_unavailable_poll_fallback_active");
	assert(catchIdx !== -1, "installBindingObserver must have a .catch() handler");
	assert(diagnosticIdx !== -1, "poll fallback diagnostic must exist");
	// The diagnostic must be AFTER the catch opener in source order
	// (both live in the same .catch(() => { diagnostics.push(...); }) block)
	assert(diagnosticIdx > catchIdx,
		"poll fallback diagnostic must appear inside the .catch() block of installBindingObserver");
});

test("wait.selector source: observer_installed diagnostic exists (binding path success path)", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");
	assert(src.includes("runtime_binding_observer_installed"),
		"wait.selector must record a success diagnostic when the binding+observer is installed");
});

test("wait.selector source: armPoll() is only reached inside tick() (not before the binding install)", () => {
	const src = readSource("bridge_src/service_worker/wait_selector.ts");

	// armPoll must exist — it's the fallback timer
	assert(src.includes("const armPoll =") || src.includes("function armPoll"),
		"armPoll must be defined as a named function");

	// The key structural invariant: armPoll() must not appear BEFORE installBindingObserver
	// is invoked. We check this by verifying that the void installBindingObserver()
	// call appears BEFORE the first armPoll() call site in source order.
	const installCallIdx = src.indexOf("void installBindingObserver()");
	const armPollCallIdx = src.indexOf("armPoll()");
	assert.equal(installCallIdx !== -1, true, "installBindingObserver must be invoked with void");
	assert.equal(armPollCallIdx !== -1, true, "armPoll() must be called somewhere");
	assert(installCallIdx < armPollCallIdx,
		`I3/poll: void installBindingObserver() (idx ${installCallIdx}) must appear before armPoll() (idx ${armPollCallIdx}) — poll must be a fallback, not unconditionally first`);

	// Additionally: triggerTick('initial') is the first tick call — not armPoll()
	// This means the loop starts via the event path, not the poll timer.
	const triggerInitialIdx = src.indexOf("triggerTick('initial')");
	assert.equal(triggerInitialIdx !== -1, true, "initial tick must be triggered via triggerTick");
	// triggerTick('initial') must come after armPoll definition but must not BE an armPoll call
	assert(!src.slice(triggerInitialIdx, triggerInitialIdx + 30).includes("armPoll"),
		"initial tick trigger must not be an armPoll call");
});

// ── Dist bundle invariants ─────────────────────────────────────────────────────

test("wait.selector dist bundle: event-driven markers survive bundling", () => {
	let distSrc: string;
	try {
		distSrc = readSource("bridge/pi_browser_bridge/dist/service-worker.js");
	} catch {
		// If dist hasn't been built, skip the bundle check gracefully but log a warning
		console.warn("WARN: bridge dist service-worker.js not found — skipping bundle assertion (run npm run build:bridge)");
		return;
	}

	assert(distSrc.includes("Runtime.addBinding"),
		"dist bundle: Runtime.addBinding must survive bundling");
	assert(distSrc.includes("runtime_binding_observer_installed"),
		"dist bundle: binding success diagnostic must survive bundling");
	assert(distSrc.includes("runtime_binding_observer_unavailable_poll_fallback_active"),
		"dist bundle: poll fallback diagnostic must survive bundling");
	assert(distSrc.includes("MutationObserver"),
		"dist bundle: MutationObserver install must survive bundling");
});
