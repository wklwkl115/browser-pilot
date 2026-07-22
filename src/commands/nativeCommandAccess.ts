import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";
import { nativeCommandToolMetadata, nativeTransferToolMetadata } from "./nativeActionMetadata.js";

const nativeCommandOwners: Readonly<Record<string, string>> = {
	tabs: "browser_tabs",
	[nativeCommandToolMetadata.browser_screenshot.command]: "browser_screenshot",
	[nativeTransferToolMetadata.browser_download.command]: "browser_download",
	[nativeTransferToolMetadata.browser_upload.command]: "browser_upload",
};

export function nativeCommandOwner(command: BridgeCommand): string | undefined {
	const schema = getNativeCommandProtocolSchema();
	return nativeCommandOwners[canonicalBridgeCommand(String(command.cmd || ""), schema)];
}

export function publicNativeCommandNames(): string[] {
	const schema = getNativeCommandProtocolSchema();
	return Object.entries(schema.commands)
		.filter(([cmd, spec]) => cmd !== "batch" && spec.internal !== true && !nativeCommandOwner({ cmd }))
		.map(([cmd]) => cmd);
}

export function isNativeWriteCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	if (!spec || spec.internal === true) return false;
	const method = String(command.method || command.action || spec.defaultMethod || "").toLowerCase();
	return (spec.methodSpecs?.[method]?.accessMode ?? spec.accessMode) === "write";
}
