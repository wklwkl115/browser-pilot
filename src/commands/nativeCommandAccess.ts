import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";

const nativeCommandOwners: Readonly<Record<string, string>> = {
	tabs: "browser_tabs",
	"screenshot.capture": "browser_screenshot",
};

export function nativeCommandOwner(command: BridgeCommand): string | undefined {
	const schema = getNativeCommandProtocolSchema();
	return nativeCommandOwners[canonicalBridgeCommand(String(command.cmd || ""), schema)];
}

export function publicNativeCommandNames(): string[] {
	const schema = getNativeCommandProtocolSchema();
	return Object.keys(schema.commands).filter((cmd) => canonicalBridgeCommand(cmd, schema) === cmd && isPublicNativeCommand({ cmd }));
}

export function isPublicNativeCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	return canonical !== "batch" && spec !== undefined && spec.internal !== true && !nativeCommandOwner({ cmd: canonical });
}

export function isNativeWriteCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	if (!spec || spec.internal === true) return false;
	const method = String(command.method || command.action || spec.defaultMethod || "").toLowerCase();
	return (spec.methodSpecs?.[method]?.accessMode ?? spec.accessMode) === "write";
}
