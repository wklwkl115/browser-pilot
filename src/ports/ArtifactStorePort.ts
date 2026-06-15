export interface ArtifactStorePort {
	writeArtifact(pathHint: string, data: Uint8Array | string, metadata?: Record<string, unknown>): Promise<{ path: string; bytes?: number }>;
	readArtifact(path: string): Promise<Uint8Array>;
}
