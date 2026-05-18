import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type WebSecurityArtifactDescriptor = {
	kind: string;
	label: string;
	path: string;
	relativePath?: string;
	mediaType: string;
	bytes: number;
	chars: number;
	lineCount: number;
	sha256: string;
	read: {
		tool: "browser_artifact";
		path: string;
		mode: "text";
	};
};

function countLines(text: string): number {
	if (!text.length) return 0;
	let count = 1;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\n") count += 1;
	}
	return text.endsWith("\n") ? count - 1 : count;
}

export async function describeTextArtifact(filePath: string, options: { artifactRoot?: string; kind: string; label: string; mediaType?: string }): Promise<WebSecurityArtifactDescriptor> {
	const buffer = await readFile(filePath);
	const text = buffer.toString("utf8");
	return {
		kind: options.kind,
		label: options.label,
		path: filePath,
		relativePath: options.artifactRoot ? path.relative(options.artifactRoot, filePath).replace(/\\/g, "/") : undefined,
		mediaType: options.mediaType || "text/plain; charset=utf-8",
		bytes: buffer.byteLength,
		chars: text.length,
		lineCount: countLines(text),
		sha256: createHash("sha256").update(buffer).digest("hex"),
		read: { tool: "browser_artifact", path: filePath, mode: "text" },
	};
}
