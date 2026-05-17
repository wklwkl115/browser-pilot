function normalizeAction(action: string): string {
	return action.trim().toLowerCase().replace(/[_.-]/g, "");
}

function commandForAction(action: string, map: Record<string, string>, toolName: string): string {
	const command = map[normalizeAction(action)];
	if (!command) throw new Error(`Unsupported ${toolName} action: ${action}`);
	return command;
}

export function waitCommandForAction(action: string): string {
	return commandForAction(action, {
		navigate: "wait.navigate",
		navigateandwait: "wait.navigateAndWait",
		waitfornavigation: "wait.navigation",
		navigation: "wait.navigation",
		loadstate: "wait.loadState",
		waitforloadstate: "wait.loadState",
		networkidle: "wait.networkIdle",
		waitfornetworkidle: "wait.networkIdle",
		selector: "wait.selector",
		waitforselector: "wait.selector",
		any: "wait.any",
		waitforany: "wait.any",
		all: "wait.all",
		waitforall: "wait.all",
		cancel: "wait.cancel",
		cancelwait: "wait.cancel",
		diagnose: "wait.diagnose",
	}, "browser_wait");
}

export function networkCommandForAction(action: string): string {
	return commandForAction(action, {
		start: "network.start",
		stop: "network.stop",
		status: "network.status",
		clear: "network.clear",
		list: "network.list",
		get: "network.get",
		body: "network.body",
		exporthar: "network.exportHar",
		export: "network.exportHar",
		wait: "network.wait",
	}, "browser_network");
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
