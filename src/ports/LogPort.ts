export interface LogPort {
	info(message: string, details?: Record<string, unknown>): void;
	warn(message: string, details?: Record<string, unknown>): void;
	error(message: string, details?: Record<string, unknown>): void;
}
