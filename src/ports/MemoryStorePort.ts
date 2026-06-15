export interface MemoryStorePort {
	read(scope: string): Promise<unknown[]>;
	write(scope: string, entry: unknown): Promise<void>;
}
