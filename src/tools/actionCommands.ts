import { commandForNativeToolAction } from "../protocol/nativeActionMetadata.js";

export function waitCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_wait", action);
}

export function networkCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_network", action);
}

export function hookCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_hook", action);
}

export function frameCommandForAction(action: string): string {
	return commandForNativeToolAction("browser_frame", action);
}
