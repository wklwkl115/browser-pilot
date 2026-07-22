import { defineNativeCommand } from "./nativeCommand.js";
import { defineExecuteCommand } from "./executeCommand.js";
import { defineObserveCommand } from "./observeCommand.js";
import { defineScreenshotCommand } from "./screenshotCommand.js";
import { defineTabsCommand } from "./tabsCommand.js";
import type { CommandRegistrar } from "./commandShared.js";

const CORE_BROWSER_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [
	defineTabsCommand,
	defineNativeCommand,
	defineExecuteCommand,
	defineObserveCommand,
	defineScreenshotCommand,
];

export const BROWSER_COMMAND_REGISTRARS: readonly CommandRegistrar[] = CORE_BROWSER_COMMAND_REGISTRARS;

export function resolveBrowserCommandRegistrars(): readonly CommandRegistrar[] {
	return BROWSER_COMMAND_REGISTRARS;
}
