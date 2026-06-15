import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../utils/fsAtomic.js";

const MEMORY_ROOT = ".browser-pilot/memory";
const SECRET_FILE = ".secret";
const SECRET_BYTES = 32;
const secretCreateLocks = new Map<string, Promise<Buffer | undefined>>();

export function memoryKernelEnabled(): boolean {
	return process.env.BROWSER_PILOT_MEMORY !== "0";
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
	const filePath = memorySecretPath(cwd);
	const pending = secretCreateLocks.get(filePath);
	if (pending) return pending;
	const created = createMemorySecret(filePath).finally(() => {
		if (secretCreateLocks.get(filePath) === created) secretCreateLocks.delete(filePath);
	});
	secretCreateLocks.set(filePath, created);
	return created;
}

async function createMemorySecret(filePath: string): Promise<Buffer | undefined> {
	const existing = await readFile(filePath, "utf8").then(normalizeSecret).catch(() => undefined);
	if (existing) return existing;
	const secret = randomBytes(SECRET_BYTES);
	const content = `${secret.toString("hex")}\n`;
	await mkdir(path.dirname(filePath), { recursive: true });
	try {
		await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as { code?: unknown }).code === "EEXIST") {
			const raced = await readFile(filePath, "utf8").then(normalizeSecret).catch(() => undefined);
			if (raced) return raced;
		}
		await atomicWriteText(filePath, content);
	}
	return await readFile(filePath, "utf8").then(normalizeSecret).then((persisted) => persisted ?? secret);
}
