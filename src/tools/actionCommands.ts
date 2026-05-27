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

export function hookCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_hook", action);
}

export function frameCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_frame", action);
}
