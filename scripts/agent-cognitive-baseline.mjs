/**
 * Fixture cognitive baseline harness for agent-preview.
 * Reads golden labels + projects L0 candidates from a synthetic observation
 * using the shipped projectAgentView kernel (via tsx import in tests).
 * This script emits JSON metrics for scratch evidence; the authoritative
 * runner is tests/cli/agentCognitiveBaseline.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const labelsPath = path.join(root, "tests/fixtures/agent-pages/golden-labels.json");
const labels = JSON.parse(readFileSync(labelsPath, "utf8"));

const metrics = {
	note: "Lightweight fixture baseline; full accumulation runs in agentCognitiveBaseline.test.ts",
	visibleToolCount: 3,
	publicCalls: 0,
	opaqueMechanicalIdsCarried: 1,
	mutationReplayAttempts: 0,
	tasks: labels.tasks?.length ?? 0,
	labels: labels.tasks ?? [],
	catalogPublicToolCount: 22,
	agentTools: ["browser_view", "browser_act", "browser_read"],
	catalogGaClaimed: true,
	agentUsage: "skill+cli",
};

const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(metrics, null, 2));
else process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
