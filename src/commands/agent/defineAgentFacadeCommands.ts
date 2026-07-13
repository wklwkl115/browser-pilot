import type { CommandRegistrarContext } from "../commandShared.js";
import { defineAgentViewCommand } from "./defineAgentView.js";
import { defineAgentActCommand } from "./defineAgentAct.js";
import { defineAgentReadCommand } from "./defineAgentRead.js";

/** Agent façade tools (view/act/read) — part of public catalog v3 / contract toolCount 22. */
export function defineAgentFacadeCommands(context: CommandRegistrarContext): void {
	defineAgentViewCommand(context);
	defineAgentActCommand(context);
	defineAgentReadCommand(context);
}
