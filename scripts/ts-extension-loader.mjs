import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw error;
		if (!context.parentURL?.startsWith("file:")) throw error;
		const parentPath = fileURLToPath(context.parentURL);
		const candidate = path.resolve(path.dirname(parentPath), `${specifier}.ts`);
		if (!existsSync(candidate)) throw error;
		return { url: pathToFileURL(candidate).href, shortCircuit: true };
	}
}
