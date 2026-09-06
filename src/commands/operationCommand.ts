import { Type } from "typebox";
import { OperationRegistry } from "../operations/operationRegistry.js";
import { persistOperation } from "../operations/operationObservation.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserCommand, runCommandHandler } from "./commandRuntime.js";
import { strictCommandParameters, type CommandRegistrarContext } from "./commandShared.js";

export function defineOperationCommand({ commands, operations = new OperationRegistry() }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_operation",
		label: "Browser Operation",
		description:
			"Inspect an execution receipt or continue declared read-only verification without replaying the write.",
		promptGuidelines: [
			"Use operationId from a write result or error. status does not contact the page; wait only re-evaluates stored declarative conditions. Legacy JavaScript expectations cannot be resumed here.",
			"returned means the browser responded, not business success. verified means an assertion holds. Only explicit business conditions determine succeeded/failed; otherwise business remains unknown.",
			"dispatched_unknown must not trigger an automatic retry. A local operation ID is not a site idempotency key or an exactly-once guarantee. Records are project-scoped, volatile, and bounded; missing records do not authorize replay.",
		],
		parameters: strictCommandParameters({
			operationId: Type.String({ pattern: "^[0-9a-fA-F-]{36}$" }),
			action: Type.Optional(
				Type.Enum(["status", "wait"], {
					description: "Default status; wait performs bounded observation only.",
				}),
			),
			waitMs: Type.Optional(
				Type.Integer({
					minimum: 100,
					maximum: 45_000,
					description: "wait only: observation budget, default 5000 ms.",
				}),
			),
		}),
		async execute(params, signal, ctx) {
			return await runCommandHandler(async () => {
				const record = operations.get(params.operationId, ctx?.cwd ?? process.cwd());
				if (params.action !== "wait") {
					if (params.waitMs !== undefined)
						throw new BrowserBridgeError("INVALID_RULE", "waitMs requires action wait");
					return jsonResult(record.view);
				}
				if (record.view.active)
					throw new BrowserBridgeError(
						"INVALID_RULE",
						"Operation is already active; inspect status instead of starting another wait",
					);
				record.view.active = true;
				try {
					await record.wait?.(params.waitMs ?? 5_000, signal);
				} finally {
					record.view.active = false;
					await persistOperation(record);
				}
				return jsonResult(record.view);
			});
		},
	});
}
