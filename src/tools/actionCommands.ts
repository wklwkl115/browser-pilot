import { commandForNativeToolAction } from "../protocol/nativeActionMetadata";

export function waitCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_wait", action);
}

export function networkCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_network", action);
}

function normalizeAction(action: string): string {
	return action.trim().toLowerCase().replace(/[_.-]/g, "");
}

function commandForAction(action: string, map: Record<string, string>, toolName: string): string {
	const command = map[normalizeAction(action)];
	if (!command) throw new Error(`Unsupported ${toolName} action: ${action}`);
	return command;
}

export function hookCommandForAction(action: string): string {
	return commandForAction(action, {
		listsessions: "hook.list_sessions",
		install: "hook.install",
		status: "hook.status",
		collect: "hook.collect",
		clear: "hook.clear",
		clearbuffer: "hook.clear_buffer",
		pause: "hook.pause",
		resume: "hook.resume",
		uninstall: "hook.uninstall",
		evaluate: "hook.evaluate",
		addeventlistener: "hook.addEventListener",
		removeeventlistener: "hook.removeEventListener",
		performance: "hook.getPerformanceEntries",
		getperformanceentries: "hook.getPerformanceEntries",
	}, "browser_hook");
}

export function frameCommandForAction(action: string): string {
	return commandForAction(action, {
		list: "frame.list",
		frames: "frame.list",
		evaluate: "frame.evaluate",
		addnewdocumentscript: "frame.addNewDocumentScript",
		addscript: "frame.addNewDocumentScript",
		removenewdocumentscript: "frame.removeNewDocumentScript",
		removescript: "frame.removeNewDocumentScript",
	}, "browser_frame");
}
