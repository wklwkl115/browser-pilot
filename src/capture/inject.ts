export function jsonForInlineScript(value: unknown): string {
	const json = JSON.stringify(value);
	return (json === undefined ? "null" : json).replace(/[<>&\u2028\u2029]/g, (char) => {
		if (char === "<") return "\\u003C";
		if (char === ">") return "\\u003E";
		if (char === "&") return "\\u0026";
		if (char === "\u2028") return "\\u2028";
		return "\\u2029";
	});
}

export function renderCaptureTemplate(template: string, values: Record<string, unknown>): string {
	return template.replace(/\$\{([^}]+)\}/g, (match, expression) => {
		const key = String(expression || "").trim();
		if (!(key in values)) throw new Error(`capture template missing value: ${key}`);
		return String(values[key]);
	});
}
