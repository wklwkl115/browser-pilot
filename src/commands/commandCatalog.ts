import { defineArtifactCommand } from "./artifactCommand.js";
import { defineNativeCommand } from "./nativeCommand.js";
import { defineEvidenceCommand } from "./evidenceCommand.js";
import { defineExecuteCommand } from "./executeCommand.js";
import { defineFrameCommand, defineHookCommand, defineNetworkCommand, defineWaitCommand } from "./nativeActionCommands.js";
import { defineObserveCommand } from "./observeCommand.js";
import { defineMemoryCommand } from "./memoryCommand.js";
import { defineScreenshotCommand } from "./screenshotCommand.js";
import { defineTabsCommand } from "./tabsCommand.js";
import { defineDownloadCommand, defineUploadCommand } from "./transferCommands.js";
import {
	defineCallbackOastCommand,
	defineCookieAnalyzeCommand,
	defineCrawlCommand,
	defineFuzzCommand,
	defineHttpReplayCommand,
	defineSqliCommand,
	defineTemplateCommand,
} from "./webSecurityCommands.js";
import type { CommandRegistrar } from "./commandShared.js";

const CORE_BROWSER_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [
	defineTabsCommand,
	defineNativeCommand,
	defineExecuteCommand,
	defineObserveCommand,
	defineDownloadCommand,
	defineUploadCommand,
	defineWaitCommand,
	defineNetworkCommand,
	defineHookCommand,
	defineEvidenceCommand,
	defineFrameCommand,
	defineScreenshotCommand,
	defineArtifactCommand,
	defineMemoryCommand,
];

const WEB_SECURITY_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [
	defineCrawlCommand,
	defineFuzzCommand,
	defineSqliCommand,
	defineTemplateCommand,
	defineCallbackOastCommand,
	defineCookieAnalyzeCommand,
	defineHttpReplayCommand,
];

export const BROWSER_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [
	...CORE_BROWSER_COMMAND_REGISTRARS,
	...WEB_SECURITY_COMMAND_REGISTRARS,
];

export const WEB_SECURITY_TOOL_NAMES = new Set([
	"browser_crawl",
	"browser_fuzz",
	"browser_sqli",
	"browser_template",
	"browser_callback_oast",
	"browser_cookie_analyze",
	"browser_http_replay",
]);

export function resolveBrowserCommandRegistrars(): readonly CommandRegistrar[] {
	return BROWSER_COMMAND_REGISTRARS;
}
