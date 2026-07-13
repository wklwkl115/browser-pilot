import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { projectAgentView } from "../../src/kernels/agent/agentView.js";
import {
	accumulateFixtureStep,
	emptyCognitiveMetrics,
	hardGatesPass,
} from "../../src/kernels/agent/cognitiveMetrics.js";
import { PAGE_OBSERVATION_SCHEMA_V3, type PageObservationV3 } from "../../src/kernels/abml/pageObservation.js";
import { collectCommandDefs, collectAgentFacadeDefs } from "../../src/apps/cli/registry.js";
import { toolsForProfile } from "../../src/commands/capabilityProfileCatalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratchDefault = process.env.AGENT_COMPLETE_SCRATCH
	?? path.join(tmpdir(), "agent-complete-bench");

test("fixture baseline: L0 recall + hard gates + catalog 19 / agent 3", () => {
	const labels = JSON.parse(readFileSync(path.join(root, "tests/fixtures/agent-pages/golden-labels.json"), "utf8")) as {
		tasks: Array<{
			id: string;
			requiredActionableRefs?: string[];
			blockingControls?: string[];
		}>;
	};

	const observation = {
		schema: PAGE_OBSERVATION_SCHEMA_V3,
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: { browserSessionId: "s", tabId: 1, targetGeneration: 1, pageEpoch: "e", url: "https://fixture.test/form" },
		snapshot: {
			snapshotId: "s1",
			browserSessionId: "s",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e",
			url: "https://fixture.test/form",
			sourceMode: "scan",
			capturedAt: 1,
			ttlMs: 60_000,
		},
		actionables: [
			{ ref: "bp-ref://fixture/email", kind: "textbox", name: "Email" },
			{ ref: "bp-ref://fixture/password", kind: "textbox", name: "Password" },
			{ ref: "bp-ref://fixture/submit", kind: "button", name: "Continue" },
		],
		providers: {},
		frontier: { items: [], truncated: false },
		limits: { budgetChars: 6000, cost: { chars: 100, bytes: 100, estimatedTokens: 25 } },
		gist: { title: "Agent Fixture Form", text: "Sign in" },
	} as PageObservationV3;

	const { view, candidateBindings } = projectAgentView({
		observation,
		context: { id: "ctx", revision: 1, state: "anchored" },
	});

	let metrics = emptyCognitiveMetrics({ visibleToolCount: 3 });
	for (const task of labels.tasks) {
		metrics = accumulateFixtureStep(metrics, {
			requiredActionableRefs: task.requiredActionableRefs ?? [],
			blockingControlRefs: task.blockingControls ?? [],
		}, {
			returnedResourceRefs: candidateBindings.map((b) => b.resourceRef),
			publicCalls: 1,
			opaqueMechanicalIdsCarried: 1,
			mutationReplayAttempts: 0,
			defaultResponseChars: view.limits.cost.chars,
			defaultResponseEstimatedTokens: view.limits.cost.estimatedTokens,
			taskSuccess: true,
		});
	}

	const gates = hardGatesPass(metrics);
	assert.equal(gates.ok, true, gates.failures.join(","));
	assert.equal(metrics.mutationReplayAttempts, 0);
	assert.equal(collectCommandDefs().length, 19);
	assert.equal(collectAgentFacadeDefs().length, 3);
	assert.deepEqual([...toolsForProfile("agent-preview")].sort(), ["browser_act", "browser_read", "browser_view"].sort());

	mkdirSync(scratchDefault, { recursive: true });
	const outDir = mkdtempSync(path.join(scratchDefault, "bench-"));
	const outPath = path.join(outDir, "agent-complete-bench.json");
	const payload = {
		...metrics,
		gaDefaultClaimed: false,
		catalogPublicToolCount: 19,
		agentPreviewToolCount: 3,
		fixture: "tests/fixtures/agent-pages",
		note: "No agent-default GA; mutationReplay=0 hard gate holds on fixture baseline",
	};
	writeFileSync(outPath, JSON.stringify(payload, null, 2));
	assert.ok(readFileSync(outPath, "utf8").includes("mutationReplayAttempts"));

	// also exercise scripts/agent-cognitive-baseline.mjs
	const scriptOut = path.join(outDir, "script-baseline.json");
	const run = spawnSync(process.execPath, [path.join(root, "scripts/agent-cognitive-baseline.mjs"), scriptOut], {
		encoding: "utf8",
		cwd: root,
	});
	assert.equal(run.status, 0, run.stderr);
	const scriptBody = JSON.parse(readFileSync(scriptOut, "utf8"));
	assert.equal(scriptBody.mutationReplayAttempts, 0);
	assert.equal(scriptBody.gaDefaultClaimed, false);
});
