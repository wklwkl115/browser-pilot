import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../utils/fsAtomic.js";

const MEMORY_ROOT = ".pi/browser-memory";
const SECRET_FILE = ".secret";
const SECRET_BYTES = 32;

export function memoryKernelEnabled(): boolean {
	return process.env.PI_BROWSER_MEMORY !== "0";
}

export function memorySecretPath(cwd?: string): string {
	return path.resolve(cwd || process.cwd(), MEMORY_ROOT, SECRET_FILE);
}

function normalizeSecret(text: string): Buffer | undefined {
	const trimmed = text.trim();
	if (!/^[a-f0-9]{64}$/i.test(trimmed)) return undefined;
	return Buffer.from(trimmed, "hex");
}

export async function readMemorySecret(cwd?: string): Promise<Buffer | undefined> {
	const text = await readFile(memorySecretPath(cwd), "utf8").catch(() => undefined);
	return text === undefined ? undefined : normalizeSecret(text);
}

export async function readOrCreateMemorySecret(cwd?: string): Promise<Buffer | undefined> {
	if (!memoryKernelEnabled()) return undefined;
	const existing = await readMemorySecret(cwd);
	if (existing) return existing;
	const secret = randomBytes(SECRET_BYTES);
	await atomicWriteText(memorySecretPath(cwd), `${secret.toString("hex")}\n`);
	return secret;
}
