import { isRecord } from "../../utils/records.js";
import { responseDistance, type ResponseFingerprint } from "./replayDiff.js";

export const SQL_DBMS_SIGNATURES: Array<{ dbms: string; patterns: RegExp[] }> = [
	{ dbms: "mysql", patterns: [/SQL syntax.*MySQL/i, /Warning.*mysql_/i, /MySqlException/i, /You have an error in your SQL syntax/i] },
	{ dbms: "postgresql", patterns: [/PostgreSQL.*ERROR/i, /pg_query\(/i, /pg_sleep/i, /unterminated quoted string/i] },
	{ dbms: "sqlite", patterns: [/SQLite(?:3)?::|sqlite error|SQLITE_ERROR/i] },
	{ dbms: "oracle", patterns: [/ORA-\d{5}/i] },
	{ dbms: "mssql", patterns: [/Microsoft SQL Server|ODBC SQL Server|SQLServerException/i, /unclosed quotation mark/i, /WAITFOR DELAY/i] },
];

const SQL_ERROR_PATTERNS = [...SQL_DBMS_SIGNATURES.flatMap((item) => item.patterns), /syntax error\s+(?:at|near)/i, /The used SELECT statements have a different number of columns/i, /Unknown column/i];

export function hasSqlError(text: string): boolean {
	return SQL_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectSqlDbms(text: string): string[] {
	return SQL_DBMS_SIGNATURES.filter((signature) => signature.patterns.some((pattern) => pattern.test(text))).map((signature) => signature.dbms);
}

export function sqliUnionMeta(payload: string): Record<string, unknown> {
	const order = payload.match(/order\s+by\s+(\d+)/i);
	if (order) return { unionTechnique: "order-by", columnCount: Number(order[1]) };
	const union = payload.match(/union\s+(?:all\s+)?select\s+([\s\S]*?)(?:--|#|\/\*|$)/i);
	if (union) {
		const cols = union[1].split(",").map((item) => item.trim()).filter(Boolean).length;
		return { unionTechnique: "union-select", columnCount: cols };
	}
	return {};
}

export function nearestBooleanTruth(fp: ResponseFingerprint, oracle: { trueFp: ResponseFingerprint; falseFp: ResponseFingerprint }): boolean {
	return responseDistance(fp, oracle.trueFp) < responseDistance(fp, oracle.falseFp);
}

export function firstBooleanOracle(results: Array<Record<string, unknown>>): { location: string; paramName: string; trueFp: ResponseFingerprint; falseFp: ResponseFingerprint } | undefined {
	for (const item of results) {
		if (item.type !== "boolean" || item.matched !== true || !isRecord(item.trueResponse) || !isRecord(item.falseResponse) || !isRecord(item.trueResponse.fingerprint) || !isRecord(item.falseResponse.fingerprint)) continue;
		return { location: String(item.location), paramName: String(item.paramName), trueFp: item.trueResponse.fingerprint as ResponseFingerprint, falseFp: item.falseResponse.fingerprint as ResponseFingerprint };
	}
	return undefined;
}
