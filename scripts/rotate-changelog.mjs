// Roll the oldest entries out of the active CHANGELOG.md into docs/changelog-history.md.
//
// CHANGELOG.md is reverse-chronological (newest entries at the top). The active file is
// byte-bounded so a fast-moving project does not let it grow without limit; the ceiling is
// enforced by `maxBytes` in tests/contracts/drift/file-ceilings.json (npm run check:file-ceilings).
// This script makes "ceiling tripped -> one command" true: it moves the oldest paragraph blocks
// (bottom of the file) into the append-only history doc until the active file is at/under TARGET_BYTES.
//
// contract: tests/contracts/drift/file-ceilings.json (CHANGELOG.md maxBytes)
// contract: tests/contracts/drift/check-package-files.mjs (CHANGELOG.md must keep documenting `npm pack --dry-run`)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const HISTORY_PATH = path.join(ROOT, "docs", "changelog-history.md");

// Keep the active file comfortably below the file-ceilings maxBytes so several new entries can be
// appended between rotations without immediately tripping the gate.
const TARGET_BYTES = 48 * 1024;

const HISTORY_HEADER = [
	"# Changelog — Archived History",
	"",
	"> 由 `npm run changelog:rotate` 从根目录 `CHANGELOG.md` 滚动归档的较旧条目（倒序，最新归档在最上，与 `CHANGELOG.md` 顶部衔接）。",
	"> 此文件只追加、不设体量上限；当前活跃条目见根目录 `CHANGELOG.md`。",
].join("\n");

const checkOnly = process.argv.includes("--check");

function byteLen(text) {
	return Buffer.byteLength(text, "utf8");
}

// Split a changelog-style doc into its leading header (title + blockquote notes) and the
// reverse-chronological list of paragraph blocks. A block is a run of lines separated from the
// next by one or more blank lines, so a dense bullet list with no blank lines stays one block.
function splitHeaderAndBlocks(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let headerEnd = lines.length;
	for (let i = 0; i < lines.length; i += 1) {
		// First content line is the first entry bullet ("- ") or a section header ("## ".."###### ").
		// The "# Title" line and "> note" lines stay in the header.
		if (/^(- |#{2,6} )/.test(lines[i])) {
			headerEnd = i;
			break;
		}
	}
	const header = lines.slice(0, headerEnd).join("\n").replace(/\s+$/, "");
	const body = lines.slice(headerEnd).join("\n").trim();
	const blocks = body.length ? body.split(/\n{2,}/) : [];
	return { header, blocks };
}

function serialize(header, blocks) {
	return `${header}\n\n${blocks.join("\n\n")}\n`;
}

const changelog = readFileSync(CHANGELOG_PATH, "utf8");
const { header, blocks } = splitHeaderAndBlocks(changelog);

if (!blocks.length) {
	console.log("rotate-changelog: CHANGELOG.md has no entries; nothing to do.");
	process.exit(0);
}

// Keep newest blocks (top) until the serialized active file would exceed TARGET_BYTES; always
// keep at least one block so the active file never becomes header-only.
const kept = [];
for (const block of blocks) {
	const candidate = serialize(header, [...kept, block]);
	if (kept.length >= 1 && byteLen(candidate) > TARGET_BYTES) break;
	kept.push(block);
}
const rotated = blocks.slice(kept.length);

const currentBytes = byteLen(changelog);
if (rotated.length === 0) {
	console.log(`rotate-changelog: CHANGELOG.md is ${currentBytes} bytes (<= target ${TARGET_BYTES}); nothing to rotate.`);
	process.exit(0);
}

let existingHistoryBody = "";
if (existsSync(HISTORY_PATH)) {
	const existing = readFileSync(HISTORY_PATH, "utf8");
	existingHistoryBody = splitHeaderAndBlocks(existing).blocks.join("\n\n");
}

const activeText = serialize(header, kept);
const historyBody = [rotated.join("\n\n"), existingHistoryBody].filter(Boolean).join("\n\n");
const historyText = `${HISTORY_HEADER}\n\n${historyBody}\n`;

const summary = {
	keptBlocks: kept.length,
	rotatedBlocks: rotated.length,
	activeBytesBefore: currentBytes,
	activeBytesAfter: byteLen(activeText),
	historyBytesAfter: byteLen(historyText),
	targetBytes: TARGET_BYTES,
};

if (checkOnly) {
	console.log(`rotate-changelog --check (no files written):\n${JSON.stringify(summary, null, 2)}`);
	process.exit(0);
}

mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
writeFileSync(CHANGELOG_PATH, activeText, "utf8");
writeFileSync(HISTORY_PATH, historyText, "utf8");
console.log(`rotate-changelog: moved ${rotated.length} oldest block(s) to docs/changelog-history.md.\n${JSON.stringify(summary, null, 2)}`);
