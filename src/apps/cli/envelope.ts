export interface CliTaxonomy {
	domain: "cli" | string;
	category: string;
	retryable: boolean;
	source: "cli" | string;
}

export interface CliRecoveryCommand {
	command: string;
	argv: string[];
	purpose?: string;
}

export interface CliRecovery {
	hint?: string;
	commands?: Array<string | CliRecoveryCommand>;
	nextActions?: string[];
}

export interface CliJsonEnvelopeBase {
	ok: boolean;
	exitCode: number;
}

export interface CliJsonSuccessEnvelope extends CliJsonEnvelopeBase {
	ok: true;
	code?: never;
	[key: string]: unknown;
}

export interface CliJsonErrorEnvelope extends CliJsonEnvelopeBase {
	ok: false;
	code: string;
	message?: string;
	taxonomy?: CliTaxonomy;
	diagnostics?: Record<string, unknown>;
	recovery?: CliRecovery;
	[key: string]: unknown;
}

export type CliJsonEnvelope = CliJsonSuccessEnvelope | CliJsonErrorEnvelope;
