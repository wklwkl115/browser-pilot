import { stableJson } from "../utils/json.js";

export function charCost(text: string): number {
	return text.length;
}

export function jsonCost(value: unknown): number {
	return stableJson(value).length;
}
