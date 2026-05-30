import { asArray, increment, isRecord, resultItems, summaryTable, topCounts, type Summary } from "./shared";

export function summarizeCookieAnalyzeData(value: unknown): Summary {
	const results = resultItems(value);
	const kindCounts: Record<string, number> = {};
	const sourceCounts: Record<string, number> = {};
	for (const item of results) {
		increment(kindCounts, item.kind ?? "unknown");
		increment(sourceCounts, item.source ?? "unknown");
	}
	const tokenInfo = (item: Record<string, unknown>) => isRecord(item.token) ? item.token : isRecord(item.jwt) ? item.jwt : undefined;
	const tokenVerified = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) ? (isRecord(token.signature) ? token.signature.verified : isRecord(token.decryption) ? token.decryption.verified : undefined) : undefined;
	};
	const tokenPayload = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) && isRecord(token.payload) ? token.payload : undefined;
	};
	const tokenMutation = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) && isRecord(token.mutation) ? (typeof token.mutation.token === "string" ? "token" : token.mutation.error) : undefined;
	};
	const tokenFormat = (item: Record<string, unknown>) => {
		const token = tokenInfo(item);
		return isRecord(token) ? token.format : undefined;
	};
	return {
		ok: isRecord(value) ? value.ok : undefined,
		inputCount: isRecord(value) ? value.inputCount : undefined,
		cookieCount: isRecord(value) ? value.cookieCount : undefined,
		tokenCount: isRecord(value) ? value.tokenCount : undefined,
		jwtCount: isRecord(value) ? value.jwtCount : undefined,
		jweCount: isRecord(value) ? value.jweCount : undefined,
		pasetoCount: isRecord(value) ? value.pasetoCount : undefined,
		sessionFormatCount: isRecord(value) ? value.sessionFormatCount : undefined,
		verifiedJwtCount: isRecord(value) ? value.verifiedJwtCount : undefined,
		verifiedTokenCount: isRecord(value) ? value.verifiedTokenCount : undefined,
		mutationCount: isRecord(value) ? value.mutationCount : undefined,
		testedSecretCandidateCount: isRecord(value) ? value.testedSecretCandidateCount : undefined,
		truncatedSecretCandidates: isRecord(value) ? value.truncatedSecretCandidates : undefined,
		claimReplayCount: isRecord(value) ? value.claimReplayCount : undefined,
		successfulClaimReplayCount: isRecord(value) ? value.successfulClaimReplayCount : undefined,
		claimReplayFailureCount: isRecord(value) ? value.claimReplayFailureCount : undefined,
		kindCounts: topCounts(kindCounts),
		sourceCounts: topCounts(sourceCounts),
		claimReplays: summaryTable(isRecord(value) ? asArray(value.claimReplays).filter(isRecord) : [], [
			{ key: "name", value: (item) => item.name },
			{ key: "format", value: (item) => item.format },
			{ key: "cookie", value: (item) => item.cookieName },
			{ key: "status", value: (item) => isRecord(item.mutated) ? item.mutated.status : undefined },
			{ key: "baseline", value: (item) => isRecord(item.baseline) ? item.baseline.status : undefined },
			{ key: "delta", value: (item) => item.delta },
		], 20),
		results: summaryTable(results, [
			{ key: "source", value: (item) => item.source },
			{ key: "name", value: (item) => item.name },
			{ key: "kind", value: (item) => item.kind },
			{ key: "format", value: (item) => tokenFormat(item) },
			{ key: "length", value: (item) => item.valueLength },
			{ key: "alg", value: (item) => { const token = tokenInfo(item); return isRecord(token) ? token.alg ?? token.enc ?? token.purpose : undefined; } },
			{ key: "kid", value: (item) => { const token = tokenInfo(item); return isRecord(token) ? token.kid : undefined; } },
			{ key: "verified", value: (item) => tokenVerified(item) },
			{ key: "claimKeys", value: (item) => tokenPayload(item) ? Object.keys(tokenPayload(item) || {}).slice(0, 20) : undefined },
			{ key: "decodings", value: (item) => Array.isArray(item.decodings) ? item.decodings.length : 0 },
			{ key: "mutation", value: (item) => tokenMutation(item) },
			{ key: "replay", value: (item) => isRecord(item.claimReplay) && isRecord(item.claimReplay.mutated) ? item.claimReplay.mutated.status : isRecord(item.claimReplay) ? item.claimReplay.error : undefined },
		], 30),
		nextActions: [
			"use browser_http_replay or bounded claimReplay settings to verify whether mutated tokens or cookies are accepted by the target",
			"read saved artifacts when token structure, verification output, or replay deltas need manual confirmation",
			"capture browser cookies with bindBrowserSession only when a URL-scoped cookie collection step is explicitly needed",
		],
	};
}
