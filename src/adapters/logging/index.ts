import type { LogPort } from "../../ports/LogPort.js";

export function createConsoleLogAdapter(writer: Pick<typeof console, "error" | "warn" | "log"> = console): LogPort {
	return {
		info: (message, details) => writer.log(message, details ?? {}),
		warn: (message, details) => writer.warn(message, details ?? {}),
		error: (message, details) => writer.error(message, details ?? {}),
	};
}
