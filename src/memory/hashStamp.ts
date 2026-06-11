import { createHmac } from "node:crypto";
import { readOrCreateMemorySecret } from "./secret.js";

export async function hmacMemoryStamp(cwd: string | undefined, origin: string, stamp: string): Promise<string | undefined> {
	const secret = await readOrCreateMemorySecret(cwd);
	if (!secret) return undefined;
	return createHmac("sha256", secret).update(origin).update("\0").update(stamp).digest("hex").slice(0, 32);
}
