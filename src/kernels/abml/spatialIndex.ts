export type SpatialRect = { x: number; y: number; w: number; h: number };

export type BoundedSpatialIndexOptions = {
	bucketSize: number;
	maxBucketsPerRect: number;
};

export type BoundedSpatialIndex<T> = {
	bucketSize: number;
	maxBucketsPerRect: number;
	values: T[];
	buckets: Map<string, T[]>;
	overflow: T[];
};

type SpatialBucketRange = { minX: number; maxX: number; minY: number; maxY: number };

function spatialBucketRange(rect: SpatialRect, bucketSize: number, maxBucketsPerRect: number): SpatialBucketRange | undefined {
	if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return undefined;
	const minX = Math.floor(rect.x / bucketSize);
	const maxX = Math.floor((rect.x + rect.w) / bucketSize);
	const minY = Math.floor(rect.y / bucketSize);
	const maxY = Math.floor((rect.y + rect.h) / bucketSize);
	const width = maxX - minX + 1;
	const height = maxY - minY + 1;
	if (width <= 0 || height <= 0 || width * height > maxBucketsPerRect) return undefined;
	return { minX, maxX, minY, maxY };
}

function visitSpatialBuckets(range: SpatialBucketRange, visit: (key: string) => void): void {
	for (let x = range.minX; x <= range.maxX; x += 1) {
		for (let y = range.minY; y <= range.maxY; y += 1) visit(`${x}:${y}`);
	}
}

export function buildBoundedSpatialIndex<T>(items: Iterable<{ value: T; rect: SpatialRect }>, options: BoundedSpatialIndexOptions): BoundedSpatialIndex<T> {
	const bucketSize = Number.isFinite(options.bucketSize) && options.bucketSize > 0 ? options.bucketSize : 1;
	const maxBucketsPerRect = Number.isFinite(options.maxBucketsPerRect) && options.maxBucketsPerRect > 0 ? Math.floor(options.maxBucketsPerRect) : 1;
	const values: T[] = [];
	const buckets = new Map<string, T[]>();
	const overflow: T[] = [];
	for (const item of items) {
		values.push(item.value);
		const range = spatialBucketRange(item.rect, bucketSize, maxBucketsPerRect);
		if (!range) {
			overflow.push(item.value);
			continue;
		}
		visitSpatialBuckets(range, (key) => {
			const bucket = buckets.get(key);
			if (bucket) bucket.push(item.value);
			else buckets.set(key, [item.value]);
		});
	}
	return { bucketSize, maxBucketsPerRect, values, buckets, overflow };
}

export function queryBoundedSpatialIndex<T>(index: BoundedSpatialIndex<T>, rect: SpatialRect): Iterable<T> {
	const range = spatialBucketRange(rect, index.bucketSize, index.maxBucketsPerRect);
	// Oversized/non-finite queries take the full-scan path. Oversized indexed values are retained in
	// overflow and included in every bounded query, so consumers never lose a valid candidate.
	if (!range) return index.values;
	const candidates = new Set<T>(index.overflow);
	visitSpatialBuckets(range, (key) => {
		for (const value of index.buckets.get(key) ?? []) candidates.add(value);
	});
	return candidates;
}
