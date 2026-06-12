import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { stableJson } from "../utils/json.js";
import { runJsAstShell } from "./webSecurity/shared/jsAstShell.js";
import { runWasmShell } from "./webSecurity/shared/wasmShell.js";
import { parseBrowserWsArgs, runWsShell } from "./webSecurity/shared/wsShell.js";

// Slash commands are a parallel operator namespace, not browser_* tools; keep discovery and
// callable-tool contracts in src/tools/toolRegistry.ts/registerTools.ts.
type EnsureStarted = () => Promise<BrowserBridgeServer>;

function commandArgsText(args: unknown): string {
	return typeof args === "string" ? args.trim() : "";
}

function parseBrowserJsAstArgs(args: unknown): { path?: string; outputPath?: string; slice?: { offset: number; length: number } } {
	const text = commandArgsText(args);
	if (!text) return {};
	const outputMatch = text.match(/(?:^|\s)--output\s+("[^"]+"|'[^']+'|\S+)/);
	const rawOutput = outputMatch ? outputMatch[1] : undefined;
	const outputPath = rawOutput ? rawOutput.replace(/^['"]|['"]$/g, "") : undefined;
	const sliceMatch = text.match(/(?:^|\s)--slice\s+(\d+)\s*:\s*(\d+)/);
	const slice = sliceMatch ? { offset: Number(sliceMatch[1]), length: Number(sliceMatch[2]) } : undefined;
	const withoutFlags = text.replace(outputMatch?.[0] || "", " ").replace(sliceMatch?.[0] || "", " ").trim();
	return { path: withoutFlags || undefined, outputPath, slice };
}

function parseBrowserWasmArgs(args: unknown): { path?: string; outputPath?: string; mode?: "metadata" | "wat" } {
	const text = commandArgsText(args);
	if (!text) return {};
	const outputMatch = text.match(/(?:^|\s)--output\s+("[^"]+"|'[^']+'|\S+)/);
	const rawOutput = outputMatch ? outputMatch[1] : undefined;
	const outputPath = rawOutput ? rawOutput.replace(/^['"]|['"]$/g, "") : undefined;
	const wat = /(?:^|\s)--wat(?:\s|$)/.test(text);
	const withoutFlags = text.replace(/(?:^|\s)--wat(?:\s|$)/g, " ").replace(outputMatch?.[0] || "", " ").trim();
	return { path: withoutFlags || undefined, outputPath, mode: wat ? "wat" : "metadata" };
}

function extensionRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function bridgePath(): string {
	return path.join(extensionRoot(), "bridge", "pi_browser_bridge");
}

export function registerBrowserCommands(pi: ExtensionAPI, server: BrowserBridgeServer, ensureStarted: EnsureStarted) {
	pi.registerCommand("browser-status", {
		description: "Show Pi browser bridge status and connected tabs",
		handler: async (_args, ctx) => {
			try {
				await ensureStarted();
			} catch {
				/* best-effort bridge startup for browser-status */
			}
			ctx.ui.notify(stableJson(server.snapshot()), server.snapshot().extensionConnected ? "info" : "warning");
		},
	});

	pi.registerCommand("browser-install", {
		description: "Show Chrome extension path for Pi browser bridge installation",
		handler: async (_args, ctx) => {
			const target = bridgePath();
			ctx.ui.notify(`Load unpacked Chrome extension from: ${target}`, "info");
			ctx.ui.setEditorText(`Install browser bridge: open chrome://extensions → Developer mode → Load unpacked → ${target}`);
		},
	});

	pi.registerCommand("browser-reload", {
		description: "Ask the browser bridge extension to reload itself and diagnose reconnect",
		handler: async (_args, ctx) => {
			try {
				const bridge = await ensureStarted();
				const before = bridge.snapshot();
				const result = await bridge.sendCommand({ cmd: "management", method: "reload" }, { timeoutMs: 5_000 });
				const after = await bridge.waitForExtensionReconnect(before.extension?.id, 10_000);
				ctx.ui.notify(`Browser extension reloaded and reconnected: ${stableJson({ reload: result, reconnect: { extension: after.extension, tabs: after.tabs.length, pending: after.pending.length } })}`, "info");
			} catch (error) {
				ctx.ui.notify(`Browser extension reload/reconnect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("browser-js-ast", {
		description: "Run internal JS AST/deobfuscation summary on explicit editor text or a local file path. Usage: /browser-js-ast [path] [--slice offset:length] [--output file]",
		handler: async (args, ctx) => {
			try {
				const parsed = parseBrowserJsAstArgs(args);
				const editorText = ctx.ui.getEditorText?.()?.trim() ?? "";
				const explicitPath = parsed.path ? path.resolve(ctx.cwd || process.cwd(), parsed.path) : undefined;
				if (!explicitPath && !editorText) {
					ctx.ui.notify("Usage: /browser-js-ast [path] [--slice offset:length] [--output file], or place explicit JS text in the editor first.", "warning");
					return;
				}
				const result = explicitPath
					? await runJsAstShell({ path: explicitPath, outputPath: parsed.outputPath, slice: parsed.slice }, { cwd: ctx.cwd })
					: await runJsAstShell({ text: editorText, fileName: "editor-input.js", outputPath: parsed.outputPath, slice: parsed.slice }, { cwd: ctx.cwd });
				ctx.ui.notify(stableJson(result.summary), "info");
				if (result.saved?.path) {
					const savedText = await readFile(result.saved.path, "utf8");
					ctx.ui.setEditorText(savedText);
					ctx.ui.notify(`JS AST reduction artifact saved: ${result.saved.path}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`browser-js-ast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("browser-wasm", {
		description: "Run internal Wasm metadata or .wat bridge output on an explicit local Wasm file. Usage: /browser-wasm <path> [--wat] [--output file]",
		handler: async (args, ctx) => {
			try {
				const parsed = parseBrowserWasmArgs(args);
				const explicitPath = parsed.path ? path.resolve(ctx.cwd || process.cwd(), parsed.path) : undefined;
				if (!explicitPath) {
					ctx.ui.notify("Usage: /browser-wasm <path> [--wat] [--output file]", "warning");
					return;
				}
				const result = await runWasmShell({ path: explicitPath, mode: parsed.mode, outputPath: parsed.outputPath }, { cwd: ctx.cwd });
				ctx.ui.notify(stableJson(result.summary), "info");
				if (result.bridge?.watArtifact?.path) {
					const savedText = await readFile(String(result.bridge.watArtifact.path), "utf8");
					ctx.ui.setEditorText(savedText);
					ctx.ui.notify(`Wasm bridge artifact saved: ${result.bridge.watArtifact.path}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`browser-wasm failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("browser-ws", {
		description: "Run internal WebSocket session/transcript primitives on explicit inputs. Usage: /browser-ws open <url> [--session id] [--header Name:Value] [--protocol value] | send --text text | replay --step text [--step '{\"text\":...,\"contains\":...}'] | wait [--contains text|--regex pattern] | collect [--output file] | close",
		handler: async (args, ctx) => {
			try {
				const parsed = parseBrowserWsArgs(args);
				if (parsed.action === "open" && parsed.url) parsed.url = path.isAbsolute(parsed.url) ? parsed.url : parsed.url;
				const result = await runWsShell(parsed, { cwd: ctx.cwd });
				ctx.ui.notify(stableJson(result.summary), "info");
				if (result.saved?.path) {
					const savedText = await readFile(String(result.saved.path), "utf8");
					ctx.ui.setEditorText(savedText);
					ctx.ui.notify(`WS transcript artifact saved: ${result.saved.path}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`browser-ws failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
