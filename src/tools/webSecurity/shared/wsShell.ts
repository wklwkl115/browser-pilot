import path from "node:path";
import { createCodedError } from "../../../utils/codedError";
import { tryJson } from "../../../utils/json";
import { saveTextArtifact } from "../../artifacts";
import { artifactFallbackName } from "../../toolAdapter";
import { isRecord, parseCommandArgs } from "./normalize";
import { closeWsSession, collectWsSession, openWsSession, replayWsSequence, sendWsSession, statusWsSession, waitWsSession, type ReplayWsSequenceStep, type WsTranscriptEntry } from "./wsSession";
import { summarizeWsSessionData } from "../../summaries/webSecurity/ws";

export type WsShellContext = { cwd?: string } | undefined;

export type WsShellAction = "open" | "status" | "send" | "replay" | "wait" | "collect" | "close";

export type WsShellParams = {
	action?: WsShellAction;
	sessionId?: string;
	url?: string;
	headers?: Record<string, string>;
	protocols?: string[];
	text?: string;
	steps?: ReplayWsSequenceStep[];
	afterSeq?: number;
	contains?: string;
	regex?: string;
	limit?: number;
	code?: number;
	reason?: string;
	timeoutMs?: number;
	maxTranscript?: number;
	outputPath?: string;
};

export type WsShellResult = {
	action: WsShellAction;
	summary: Record<string, unknown>;
	result: Record<string, unknown>;
	saved?: { path: string; chars: number; bytes: number; privacy: Record<string, unknown> };
};

function wsShellInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "WsShellInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

function asAction(value: unknown): WsShellAction {
	const normalized = String(value || "status").trim().toLowerCase();
	if (["open", "status", "send", "replay", "wait", "collect", "close"].includes(normalized)) return normalized as WsShellAction;
	throw wsShellInputError(`Unsupported ws shell action: ${String(value)}`, { action: value });
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		return text || undefined;
	}
	return undefined;
}

function parseHeaderArgs(value: unknown): Record<string, string> {
	const tokens = parseCommandArgs(value);
	const out: Record<string, string> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--header" || token === "-H") {
			const next = tokens[index + 1];
			if (!next || !next.includes(":")) throw wsShellInputError("/browser-ws --header requires Name:Value", { flag: token });
			index += 1;
			const splitAt = next.indexOf(":");
			const name = next.slice(0, splitAt).trim();
			const headerValue = next.slice(splitAt + 1).trim();
			if (!name) throw wsShellInputError("/browser-ws header name must be non-empty", { flag: token });
			out[name] = headerValue;
		}
	}
	return out;
}

function artifactPayload(action: WsShellAction, result: Record<string, unknown>): string | undefined {
	if (action !== "collect" && action !== "replay") return undefined;
	return JSON.stringify(result, null, 2);
}

export async function runWsShell(params: WsShellParams, ctx: WsShellContext): Promise<WsShellResult> {
	const action = asAction(params.action);
	let result: Record<string, unknown>;
	switch (action) {
		case "open":
			result = { session: await openWsSession({ sessionId: params.sessionId, url: String(params.url || ""), headers: params.headers, protocols: params.protocols, timeoutMs: params.timeoutMs, maxTranscript: params.maxTranscript }) };
			break;
		case "status":
			result = { session: statusWsSession(params.sessionId) };
			break;
		case "send":
			result = await sendWsSession({ sessionId: params.sessionId, text: String(params.text || "") });
			break;
		case "replay":
			result = await replayWsSequence({ sessionId: params.sessionId, steps: params.steps || [] }) as unknown as Record<string, unknown>;
			break;
		case "wait":
			result = await waitWsSession({ sessionId: params.sessionId, afterSeq: params.afterSeq, contains: params.contains, regex: params.regex, timeoutMs: params.timeoutMs }) as unknown as Record<string, unknown>;
			break;
		case "collect":
			result = collectWsSession({ sessionId: params.sessionId, afterSeq: params.afterSeq, limit: params.limit }) as unknown as Record<string, unknown>;
			break;
		case "close":
			result = { session: await closeWsSession({ sessionId: params.sessionId, code: params.code, reason: params.reason, timeoutMs: params.timeoutMs }) };
			break;
	}
	const summary = summarizeWsSessionData(action, result);
	let saved: WsShellResult["saved"];
	const payload = artifactPayload(action, result);
	const replayFailure = action === "replay" && result.failure && typeof result.failure === "object" ? result.failure as Record<string, unknown> : undefined;
	const forceSave = !!replayFailure;
	if (payload && (forceSave || params.outputPath || payload.length > 8_000)) {
		saved = await saveTextArtifact(ctx, params.outputPath, artifactFallbackName(forceSave ? "ws-replay-failure" : "ws-transcript"), payload);
		summary.transcriptArtifact = { path: saved.path, bytes: saved.bytes, chars: saved.chars };
		if (forceSave) summary.partialTranscriptArtifact = { path: saved.path, bytes: saved.bytes, chars: saved.chars };
	}
	return { action, summary, result, saved };
}

export function defaultWsArtifactPath(ctx: WsShellContext, name = "ws-transcript.json"): string {
	return path.resolve(ctx?.cwd || process.cwd(), ".pi", "browser-artifacts", name);
}

export function parseBrowserWsArgs(args: unknown): WsShellParams {
	const tokens = parseCommandArgs(args);
	if (!tokens.length) return { action: "status" };
	const params: WsShellParams = {};
	const positionals: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const next = tokens[index + 1];
		switch (token) {
			case "--session": params.sessionId = next; index += 1; break;
			case "--url": params.url = next; index += 1; break;
			case "--text": params.text = next; index += 1; break;
			case "--steps-json":
				if (!next) throw wsShellInputError("/browser-ws --steps-json requires a JSON array", { flag: token });
				params.steps = parseReplayStepsJson(next);
				index += 1;
				break;
			case "--step":
				if (!next) throw wsShellInputError("/browser-ws --step requires explicit text or JSON", { flag: token });
				params.steps = [...(params.steps || []), parseReplayStep(next)];
				index += 1;
				break;
			case "--contains": params.contains = next; index += 1; break;
			case "--regex": params.regex = next; index += 1; break;
			case "--after": params.afterSeq = Number(next); index += 1; break;
			case "--limit": params.limit = Number(next); index += 1; break;
			case "--code": params.code = Number(next); index += 1; break;
			case "--reason": params.reason = next; index += 1; break;
			case "--timeout": params.timeoutMs = Number(next); index += 1; break;
			case "--max-transcript": params.maxTranscript = Number(next); index += 1; break;
			case "--output": params.outputPath = next; index += 1; break;
			case "--protocol": params.protocols = [...(params.protocols || []), String(next || "")]; index += 1; break;
			case "--header":
				if (!next) throw wsShellInputError("/browser-ws --header requires Name:Value", { flag: token });
				params.headers = { ...(params.headers || {}), ...parseHeaderArgs(`--header ${JSON.stringify(next)}`) };
				index += 1;
				break;
			default:
				throw wsShellInputError(`Unsupported /browser-ws flag: ${token}`, { flag: token });
		}
	}
	if (positionals.length) params.action = asAction(positionals[0]);
	if (positionals.length > 1 && !params.url && params.action === "open") params.url = positionals[1];
	return params;
}

function parseReplayStep(value: string): ReplayWsSequenceStep {
	const parsed = safeJsonValue(value);
	if (isRecord(parsed)) {
		const rec = parsed;
		if (typeof rec.text !== "string" || !rec.text.length) throw wsShellInputError("/browser-ws replay step JSON requires text", { field: "text" });
		return {
			text: rec.text,
			contains: typeof rec.contains === "string" ? rec.contains : undefined,
			regex: typeof rec.regex === "string" ? rec.regex : undefined,
			timeoutMs: typeof rec.timeoutMs === "number" ? rec.timeoutMs : typeof rec.timeout_ms === "number" ? rec.timeout_ms : undefined,
		};
	}
	return { text: value };
}

function parseReplayStepsJson(value: string): ReplayWsSequenceStep[] {
	const parsed = safeJsonValue(value);
	if (!Array.isArray(parsed)) throw wsShellInputError("/browser-ws --steps-json requires a JSON array", { field: "steps-json" });
	return parsed.map((item) => parseReplayStep(JSON.stringify(item)));
}

function safeJsonValue(value: string): unknown {
	return tryJson(value);
}

export function transcriptLastSeq(events: WsTranscriptEntry[] | undefined): number {
	return Array.isArray(events) && events.length ? Number(events.at(-1)?.seq || 0) : 0;
}
