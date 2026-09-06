import assert from "node:assert/strict";
import test from "node:test";
import { taskNeedFixture } from "../helpers/taskNeedFixture.ts";

const { bindTaskNeed } = await import(new URL("../../scripts/lib/task-need-oracle.mjs", import.meta.url).href);
const { evaluateNeedPath, responseBytes } = await import(
	new URL("../../scripts/lib/task-need-reading.mjs", import.meta.url).href
);
const uri = "browser-pilot://observation/returned-by-server";
const response = (value: unknown) => ({
	contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
});
const initial = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

for (const profile of ["page", "wholeGroup", "progressivePacket"])
	test(`${profile} stops immediately when inline information already suffices`, async () => {
		const f = taskNeedFixture();
		const first = initial({ ...f.delivery(), frontier: { items: [{ resourceUri: uri }] } });
		const result = await evaluateNeedPath({
			profile,
			initialResponse: first,
			need: bindTaskNeed(f.observation, f.contract),
			input: f.spec,
			readResource: () => {
				throw new Error("No expansion should be attempted");
			},
			budget: { maxResourceReads: 0, maxContextJsonBytes: 100000 },
		});
		assert.equal(result.status, "satisfied");
		assert.equal(result.resourceReads, 0);
		assert.equal(result.contextJsonBytes, responseBytes(first));
	});

test("progressive reads discover opaque packet links and include index and expansion bytes", async () => {
	const f = taskNeedFixture();
	const indexUri = uri + "/index/0";
	const packetUri = uri + "/opaque-provided-packet";
	const first = initial({ frontier: { items: [{ ref: "frontier:task-view", resourceUri: indexUri }] } });
	const index = response({ packetIndex: { packets: [{ question: "Note context", resourceUri: packetUri }] } });
	const expanded = response(f.delivery());
	const reads: string[] = [];
	const result = await evaluateNeedPath({
		profile: "progressivePacket",
		initialResponse: first,
		need: bindTaskNeed(f.observation, f.contract),
		input: f.spec,
		readResource: (requested: string) => {
			reads.push(requested);
			return requested === indexUri ? index : expanded;
		},
	});
	assert.equal(result.status, "satisfied");
	assert.deepEqual(reads, [indexUri, packetUri]);
	assert.equal(
		result.contextJsonBytes,
		[first, index, expanded].reduce((sum, item) => sum + responseBytes(item), 0),
	);
});

test("unresolved group contents and repeated links terminate as unsatisfied, not a cheap success", async () => {
	const f = taskNeedFixture();
	const first = initial({ frontier: { items: [{ ref: "frontier:task-view", resourceUri: uri }] } });
	const result = await evaluateNeedPath({
		profile: "wholeGroup",
		initialResponse: first,
		need: bindTaskNeed(f.observation, f.contract),
		input: f.spec,
		readResource: () => response({ nextUri: uri, scope: { contextComplete: true }, gaps: [] }),
	});
	assert.equal(result.status, "unsatisfied");
	assert.equal(result.reason, "no-unread-resource");
	assert.equal(result.resourceReads, 1);
});

test("resource-count exhaustion and byte rejection cannot use inadmissible evidence", async () => {
	const f = taskNeedFixture();
	const first = initial({ frontier: { items: [{ resourceUri: uri }] } });
	const common = {
		profile: "page",
		initialResponse: first,
		need: bindTaskNeed(f.observation, f.contract),
		input: f.spec,
	};
	const countLimited = await evaluateNeedPath({
		...common,
		readResource: () => {
			throw new Error("Must not read");
		},
		budget: { maxResourceReads: 0, maxContextJsonBytes: 100000 },
	});
	assert.equal(countLimited.status, "budget-exhausted");
	assert.equal(countLimited.reason, "resource-read-limit");
	const expanded = response(f.delivery());
	const byteLimited = await evaluateNeedPath({
		...common,
		readResource: () => expanded,
		budget: { maxResourceReads: 2, maxContextJsonBytes: responseBytes(first) },
	});
	assert.equal(byteLimited.status, "budget-exhausted");
	assert.equal(byteLimited.contextJsonBytes, responseBytes(first));
	assert.equal(byteLimited.obtainedResponseJsonBytes, responseBytes(first) + responseBytes(expanded));
	assert.equal(byteLimited.trace.at(-1).admitted, false);
	assert.ok(byteLimited.missing.includes("subject-value"));
});

test("failed resource attempts are charged as normalized errors and do not refresh the snapshot", async () => {
	const f = taskNeedFixture();
	const first = initial({ frontier: { items: [{ resourceUri: uri }] } });
	const result = await evaluateNeedPath({
		profile: "page",
		initialResponse: first,
		need: bindTaskNeed(f.observation, f.contract),
		input: f.spec,
		readResource: () => {
			throw new Error("Private path must not enter the report");
		},
	});
	assert.equal(result.status, "unsatisfied");
	assert.equal(result.reason, "resource-read-failed");
	assert.equal(result.resourceReads, 1);
	assert.ok(result.contextJsonBytes > responseBytes(first));
	assert.ok(!JSON.stringify(result).includes("Private path"));
});
