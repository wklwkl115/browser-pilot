import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(root, "ARCHIVE.md");
const roadmapPath = path.join(root, "ROADMAP.md");
const todoPath = path.join(root, "TODO.md");
const currentPath = path.join(root, "CURRENT.md");
const archiveDir = path.join(root, "docs", "archive");
const checkOnly = process.argv.includes("--check");

const indexInputs = [archivePath, roadmapPath, todoPath, currentPath, archiveDir];
const presentIndexInputs = indexInputs.filter((file) => existsSync(file));
if (presentIndexInputs.length === 0) {
	console.log(checkOnly ? "doc indexes skipped; governance docs absent" : "doc index sync skipped; governance docs absent");
	process.exit(0);
}
if (presentIndexInputs.length !== indexInputs.length) {
	const missing = indexInputs.filter((file) => !existsSync(file)).map((file) => path.relative(root, file).replace(/\\/g, "/"));
	throw new Error(`Unable to sync doc indexes; missing governance input(s): ${missing.join(", ")}`);
}

const files = {
	compressionPlan: "docs/archive-history-compression-plan.md",
	docStructure: "docs/document-structure.md",
};

function titleCaseWord(word) {
	return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function inferArchiveLabel(baseName) {
	const explicit = {
		"bridge-esm-history": "Bridge ESM / dist runtime",
		"governance-history": "本地工程治理期",
		"orchestration-history": "已撤回 orchestration / target resolver / profile isolation",
	};
	if (explicit[baseName]) return explicit[baseName];
	return baseName
		.replace(/-history$/, "")
		.split("-")
		.map(titleCaseWord)
		.join(" ");
}

function collectArchivePairs() {
	const filesInDir = readdirSync(archiveDir).filter((file) => file.endsWith(".md")).sort();
	const summaryFiles = filesInDir.filter((file) => !file.endsWith(".full.md"));
	return summaryFiles.map((summary) => {
		const base = summary.replace(/\.md$/, "");
		const full = `${base}.full.md`;
		const range = /^([0-9]+-[0-9]+)/.exec(readFileSync(path.join(archiveDir, summary), "utf8"))?.[1];
		return {
			base,
			summary: `docs/archive/${summary}`,
			full: `docs/archive/${full}`,
			label: inferArchiveLabel(base),
			range,
		};
	});
}

const archivePairs = collectArchivePairs();
const archiveHistoryHeading = archivePairs.some((pair) => pair.range) ? `## 历史阶段摘要（${archivePairs.map((pair) => pair.range).filter(Boolean).join(" / ")})` : "## 历史阶段摘要";
const archiveHistoryBlock = `${archiveHistoryHeading}\n\n${archivePairs.map((pair) => `- ${pair.range ? `${pair.range}：` : ""}${pair.label}历史摘要见 \`${pair.summary}\``).join("\n")}\n- 更细历史拆分建议与仍保持 future-facing 的非激活项见 \`${files.compressionPlan}\`。\n\n## 详细历史记录已迁出\n\n逐条历史明细已迁到以下文件：\n\n${archivePairs.map((pair) => `- \`${pair.full}\``).join("\n")}\n\n主 \`ARCHIVE.md\` 只保留阶段摘要与入口索引，避免继续膨胀。`;

const roadmapArchiveSentence = `这些不是“遗漏未完成 bug”，而是**明确延后或保持未激活**的 future work；需要新需求时再开新 TODO/RFC，不建议重新塞回当前执行队列。历史压缩后的阶段归档见：${archivePairs.map((pair) => `\`${pair.summary}\``).join("、")}；逐条详档见对应 \`*.full.md\` 文件。`;

const todoEntryLine = `- 文档结构规范：\`${files.docStructure}\`；文档同步脚本：\`npm run docs:sync\`。`;
const currentEntryLine = `- 文档结构规范：\`${files.docStructure}\`；archive 摘要/详档入口由 \`npm run docs:sync\` 同步。`;

function writeOrCheck(file, next, label) {
	const current = readFileSync(file, "utf8");
	if (current === next) return;
	if (checkOnly) {
		throw new Error(`${label} is stale; run npm run docs:sync`);
	}
	writeFileSync(file, next, "utf8");
}

function syncArchive() {
	const text = readFileSync(archivePath, "utf8");
	const blockStart = text.indexOf("## 历史阶段摘要");
	if (blockStart < 0) throw new Error("Unable to find ARCHIVE history summary block");
	const detailStart = text.indexOf("## 详细历史记录已迁出", blockStart);
	if (detailStart < 0) throw new Error("Unable to find ARCHIVE detailed-history marker");
	const detailNext = text.indexOf("\n## ", detailStart + 1);
	const end = detailNext >= 0 ? detailNext : text.length;
	const next = `${text.slice(0, blockStart)}${archiveHistoryBlock}\n${text.slice(end)}`;
	writeOrCheck(archivePath, next, "ARCHIVE.md archive index");
}

function syncRoadmap() {
	const text = readFileSync(roadmapPath, "utf8");
	const next = text.replace(/这些不是“遗漏未完成 bug”[\s\S]*?\n?$/, `${roadmapArchiveSentence}\n`);
	writeOrCheck(roadmapPath, next, "ROADMAP.md archive index");
}

function syncTodo() {
	const text = readFileSync(todoPath, "utf8");
	const lines = text.split(/\r?\n/).filter(Boolean);
	const filtered = lines.filter(
		(line) => !(line.startsWith("- 文档结构规范：") && line.includes(files.docStructure)),
	);
	const roadmapIndex = filtered.findIndex((line) => line.startsWith("- 后续路线与建议："));
	const maintainIndex = filtered.findIndex((line) => line.startsWith("维护规则："));
	const insertAt = roadmapIndex >= 0 ? roadmapIndex + 1 : maintainIndex >= 0 ? maintainIndex : filtered.length;
	filtered.splice(insertAt, 0, todoEntryLine);
	writeOrCheck(todoPath, `${filtered.join("\n")}\n`, "TODO.md structure link");
}

function syncCurrent() {
	const text = readFileSync(currentPath, "utf8");
	const lines = text.split(/\r?\n/);
	const filtered = lines.filter((line) => !(line.startsWith("- 文档结构规范：") && line.includes(files.docStructure)));
	let insertAt = filtered.findIndex((line) => line.startsWith("- 当前主链路："));
	if (insertAt < 0) insertAt = filtered.findIndex((line) => line.startsWith("## ")) + 1;
	if (insertAt < 1) insertAt = 2;
	filtered.splice(insertAt, 0, currentEntryLine);
	writeOrCheck(currentPath, `${filtered.join("\n").trimEnd()}\n`, "CURRENT.md structure link");
}

syncArchive();
syncRoadmap();
syncTodo();
syncCurrent();
console.log(checkOnly ? "doc indexes ok" : "doc indexes synced");
