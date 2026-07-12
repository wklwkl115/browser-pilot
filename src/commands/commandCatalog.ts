import { defineArtifactCommand } from "./artifactCommand.js";
import { defineNativeCommand } from "./nativeCommand.js";
import { defineEvidenceCommand } from "./evidenceCommand.js";
import { defineExecuteCommand } from "./executeCommand.js";
import { defineFrameCommand, defineHookCommand, defineNetworkCommand } from "./nativeActionCommands.js";
import { defineObserveCommand } from "./observeCommand.js";
import { defineScreenshotCommand } from "./screenshotCommand.js";
import { defineTabsCommand } from "./tabsCommand.js";
import { defineDownloadCommand, defineUploadCommand } from "./transferCommands.js";
import { defineCallbackOastCommand } from "./webSecurity/commands/registerCallbackOast.js";
import { defineCookieAnalyzeCommand } from "./webSecurity/commands/registerCookieAnalyze.js";
import { defineCrawlCommand } from "./webSecurity/commands/registerCrawl.js";
import { defineFuzzCommand } from "./webSecurity/commands/registerFuzz.js";
import { defineHttpReplayCommand } from "./webSecurity/commands/registerHttpReplay.js";
import { defineSqliCommand } from "./webSecurity/commands/registerSqli.js";
import { defineTemplateCommand } from "./webSecurity/commands/registerTemplate.js";
import type { CommandRegistrar } from "./commandShared.js";

const CORE_BROWSER_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [
	defineTabsCommand,
	defineNativeCommand,
	defineExecuteCommand,
	defineObserveCommand,
	defineDownloadCommand,
	defineUploadCommand,
	defineNetworkCommand,
	defineHookCommand,
	defineEvidenceCommand,
	defineFrameCommand,
	defineScreenshotCommand,
	defineArtifactCommand,
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

export function resolveBrowserCommandRegistrars(): readonly CommandRegistrar[] {
	return BROWSER_COMMAND_REGISTRARS;
}
