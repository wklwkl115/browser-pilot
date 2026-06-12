export function blockMarkers(id, command = "npm run docs:sync") {
	return {
		begin: `<!-- BEGIN GENERATED: ${id} (${command}) -->`,
		end: `<!-- END GENERATED: ${id} -->`,
	};
}

export function renderManagedBlock(id, content, command) {
	const markers = blockMarkers(id, command);
	return `${markers.begin}\n${content.trimEnd()}\n${markers.end}`;
}

export function replaceManagedBlock(text, id, content, command) {
	const markers = blockMarkers(id, command);
	const begin = text.indexOf(markers.begin);
	const end = text.indexOf(markers.end);
	if (begin < 0 || end < begin) throw new Error(`managed block missing: ${id}`);
	const afterEnd = end + markers.end.length;
	return `${text.slice(0, begin)}${renderManagedBlock(id, content, command)}${text.slice(afterEnd)}`;
}

export function managedBlockContent(text, id, command) {
	const markers = blockMarkers(id, command);
	const begin = text.indexOf(markers.begin);
	const end = text.indexOf(markers.end);
	if (begin < 0 || end < begin) return "";
	return text.slice(begin + markers.begin.length, end).trim();
}

export function parseMarkdownTable(markdown) {
	const rows = markdown.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
	if (rows.length < 2) return { headers: [], rows: [] };
	const split = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
	const headers = split(rows[0]);
	return { headers, rows: rows.slice(2).map(split).filter((row) => row.length === headers.length) };
}

export function renderMarkdownTable(headers, rows) {
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

export function preserveMarkdownTableCells(existingMarkdown, nextRows, options) {
	const keyColumn = options.keyColumn || 0;
	const preserveColumns = options.preserveColumns || [];
	const existing = parseMarkdownTable(existingMarkdown);
	const byKey = new Map(existing.rows.map((row) => [row[keyColumn], row]));
	return nextRows.map((row) => {
		const old = byKey.get(row[keyColumn]);
		if (!old) return row;
		const copy = [...row];
		for (const column of preserveColumns) {
			if (old[column] !== undefined) copy[column] = old[column];
		}
		return copy;
	});
}
