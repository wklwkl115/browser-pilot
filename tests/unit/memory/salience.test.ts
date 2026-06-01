import test from "node:test";
import assert from "node:assert/strict";
import { memorySimilarity, DEDUP_SIMILARITY, SIMILAR_SIMILARITY } from "../../../src/tools/memory/salience.ts";

const login = { title: "login flow", triggers: ["login", "auth"], body: "open page, click submit, read result" };

test("identical memory scores 1", () => {
	assert.equal(memorySimilarity(login, { ...login }), 1);
});

test("distinct flows on the same site score low (not merged)", () => {
	const checkout = { title: "checkout payment", triggers: ["checkout", "pay"], body: "add to cart, pay, confirm order" };
	assert(memorySimilarity(login, checkout) < SIMILAR_SIMILARITY, "different title/triggers/body must stay below the similar threshold");
});

test("a reworded copy of the same SOP scores at/above the dedup threshold", () => {
	const reworded = { title: "login flow", triggers: ["login", "auth"], body: "navigate then submit credentials and verify" };
	assert(memorySimilarity(login, reworded) >= DEDUP_SIMILARITY, "same identity with reworded body must be treated as a duplicate");
});

test("a different title but shared triggers+body lands in the soft 'similar' band", () => {
	// title differs (so not an auto-dedup) but triggers and body overlap -> a soft
	// candidate the agent can choose to supersede.
	const related = { title: "sign in page", triggers: ["login", "auth"], body: login.body };
	const sim = memorySimilarity(login, related);
	assert(sim >= SIMILAR_SIMILARITY && sim < DEDUP_SIMILARITY, `different title, shared triggers+body should be a soft candidate: ${sim}`);
});

test("similarity is symmetric and bounded", () => {
	const other = { title: "search and like", triggers: ["search"], body: "type query, click first, like" };
	assert.equal(memorySimilarity(login, other), memorySimilarity(other, login));
	const s = memorySimilarity(login, other);
	assert(s >= 0 && s <= 1);
});
