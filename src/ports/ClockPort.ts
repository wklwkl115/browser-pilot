export interface ClockPort {
	now(): number;
	isoNow(): string;
}
