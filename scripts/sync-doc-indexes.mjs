import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(root, "ARCHIVE.md");
const roadmapPath = path.join(root, "ROADMAP.md");
const todoPath = path.join(root, "TODO.md");
const currentPath = path.join(root, "CURRENT.md");
const archiveDir = path.join(root, "docs", "archive");

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

const todoEntryLine = `- 文档结构规范：\`${files.docStructure}\`；索引同步脚本：\`npm run docs:sync-indexes\`。`;
const currentEntryLine = `- 文档结构规范：\`${files.docStructure}\`；archive 摘要/详档入口由 \`npm run docs:sync-indexes\` 同步。`;

function syncArchive() {
	const text = readFileSync(archivePath, "utf8");
	const blockStart = text.indexOf("## 历史阶段摘要");
	if (blockStart < 0) throw new Error("Unable to find ARCHIVE history summary block");
	const detailStart = text.indexOf("## 详细历史记录已迁出", blockStart);
	if (detailStart < 0) throw new Error("Unable to find ARCHIVE detailed-history marker");
	const detailNext = text.indexOf("\n## ", detailStart + 1);
	const end = detailNext >= 0 ? detailNext : text.length;
	const next = `${text.slice(0, blockStart)}${archiveHistoryBlock}\n${text.slice(end)}`;
	writeFileSync(archivePath, next, "utf8");
}

function syncRoadmap() {
	const text = readFileSync(roadmapPath, "utf8");
	const next = text.replace(/这些不是“遗漏未完成 bug”[\s\S]*?\n?$/, `${roadmapArchiveSentence}\n`);
	writeFileSync(roadmapPath, next, "utf8");
}

function syncTodo() {
	const text = readFileSync(todoPath, "utf8");
	const lines = text.split(/\r?\n/).filter(Boolean);
	const filtered = lines.filter(
		(line) => !(line.startsWith("- 文档结构规范：") && line.includes(files.docStructure) && line.includes("npm run docs:sync-indexes")),
	);
	const roadmapIndex = filtered.findIndex((line) => line.startsWith("- 后续路线与建议："));
	const maintainIndex = filtered.findIndex((line) => line.startsWith("维护规则："));
	const insertAt = roadmapIndex >= 0 ? roadmapIndex + 1 : maintainIndex >= 0 ? maintainIndex : filtered.length;
	filtered.splice(insertAt, 0, todoEntryLine);
	writeFileSync(todoPath, `${filtered.join("\n")}\n`, "utf8");
}

function syncCurrent() {
	const text = readFileSync(currentPath, "utf8");
	const lines = text.split(/\r?\n/);
	const filtered = lines.filter((line) => line !== currentEntryLine);
	let insertAt = filtered.findIndex((line) => line.startsWith("- 当前主链路："));
	if (insertAt < 0) insertAt = filtered.findIndex((line) => line.startsWith("## ")) + 1;
	if (insertAt < 1) insertAt = 2;
	filtered.splice(insertAt, 0, currentEntryLine);
	writeFileSync(currentPath, `${filtered.join("\n").trimEnd()}\n`, "utf8");
}

syncArchive();
syncRoadmap();
syncTodo();
syncCurrent();
console.log("doc indexes synced");
