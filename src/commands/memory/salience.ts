import {
	DEDUP_SIMILARITY,
	SIMILAR_SIMILARITY,
	memorySimilarity as kernelMemorySimilarity,
} from "../../kernels/memory/salience.js";

export { DEDUP_SIMILARITY, SIMILAR_SIMILARITY };

export type MemoryTextParts = { title: string; triggers: string[]; body: string };

export function memorySimilarity(a: MemoryTextParts, b: MemoryTextParts): number {
	return kernelMemorySimilarity(a, b);
}
