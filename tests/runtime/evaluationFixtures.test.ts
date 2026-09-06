import test from "node:test";
import assert from "node:assert/strict";

const { startEvaluationFixtures } = await import(
	new URL("../../scripts/lib/browser-eval-fixtures.mjs", import.meta.url).href
);

test("evaluation fixtures expose distinct frame origins without relaxing page eval policy", async () => {
	const fixture = await startEvaluationFixtures();
	try {
		assert.notEqual(new URL(fixture.url).origin, fixture.crossOrigin);
		const response = await fetch(fixture.url + "frames/cross");
		const policy = response.headers.get("content-security-policy") ?? "";
		assert.ok(policy.includes(fixture.crossOrigin));
		assert.ok(!policy.includes("unsafe-eval"));
		assert.ok((await response.text()).includes(fixture.crossOrigin + "/frame-child"));
		const nested = await fetch(fixture.url + "frame-middle");
		assert.ok((await nested.text()).includes(fixture.crossOrigin + "/frame-child"));
		const child = await fetch(fixture.crossOrigin + "/frame-child");
		assert.ok((await child.text()).includes('value="child"'));
	} finally {
		await fixture.close();
	}
});

test("evaluation fixture oracles isolate saved requests and rejected submissions by round", async () => {
	const fixture = await startEvaluationFixtures();
	try {
		const [saved, failed] = await Promise.all([
			fetch(fixture.url + "api/cases?run=1", { method: "POST", body: "one request" }),
			fetch(fixture.url + "api/failure?run=2", { method: "POST" }),
		]);
		assert.equal(saved.status, 200);
		await saved.text();
		assert.equal(failed.status, 503);
		await failed.text();
		assert.deepEqual(fixture.submissions(1), ["one request"]);
		assert.deepEqual(fixture.submissions(2), []);
		const readback = await fetch(fixture.url + "api/cases/CASE-001?run=1");
		assert.deepEqual(await readback.json(), { id: "CASE-001", title: "one request" });
		assert.equal((await fetch(fixture.url + "api/cases/CASE-001?run=2")).status, 404);
		assert.equal(fixture.failedRequests(1), 0);
		assert.equal(fixture.failedRequests(2), 1);
	} finally {
		await fixture.close();
	}
});
