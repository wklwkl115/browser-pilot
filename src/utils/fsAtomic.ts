import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`);
	await mkdir(dir, { recursive: true });
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}
