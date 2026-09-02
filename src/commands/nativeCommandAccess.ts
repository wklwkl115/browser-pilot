import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";

export type NativeCommandTier = "core" | "advanced";

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
	return Object.keys(schema.commands).filter(
		(cmd) => canonicalBridgeCommand(cmd, schema) === cmd && isPublicNativeCommand({ cmd }),
	);
}

/** Public commands agents reach for in ordinary tasks; advanced ones stay behind the resource index. */
export function coreNativeCommandNames(): string[] {
	return publicNativeCommandNames().filter((cmd) => nativeCommandTier(cmd) === "core");
}

export function nativeCommandTier(cmd: string): NativeCommandTier {
	const schema = getNativeCommandProtocolSchema();
	return schema.commands[canonicalBridgeCommand(cmd, schema)]?.tier === "advanced" ? "advanced" : "core";
}

export function isPublicNativeCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	return spec !== undefined && spec.internal !== true && !nativeCommandOwner({ cmd: canonical });
}

export function isNativeWriteCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	if (!spec || spec.internal === true) return false;
	const method = String(command.method || command.action || spec.defaultMethod || "").toLowerCase();
	return (spec.methodSpecs?.[method]?.accessMode ?? spec.accessMode) === "write";
}

export function isNativeTabScopedCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	return schema.commands[canonical]?.tabScoped === true;
}
