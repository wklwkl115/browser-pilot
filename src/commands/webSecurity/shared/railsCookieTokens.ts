import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac, pbkdf2, randomBytes } from "node:crypto";
import { tryJson } from "../../../utils/json.js";
import { asString, base64UrlDecode, base64UrlEncode, isRecord, sha256Hex } from "./normalize.js";

type SecretMatch = Record<string, unknown>;
type SignatureVariant = {
	digest: "sha1" | "sha256" | "sha384" | "sha512";
	keySource: string;
	keyBytes: Buffer;
	keyLength?: number;
	salt?: string;
	derivation?: string;
};
type RailsEncryptionVariant = {
	cipher: "aes-256-gcm" | "aes-256-cbc";
	keySource: string;
	keyBytes: Buffer;
	keyLength: number;
	derivation: "direct" | "pbkdf2";
	digest?: SignatureVariant["digest"];
	salt?: string;
};
export type RailsTokenHelpers = {
	decodePrintableJsonValue(buffer: Buffer): { text?: string; json?: unknown };
	secretByteCandidates(secret: string): Array<{ source: string; bytes: Buffer }>;
};

const RAILS_PBKDF2_CACHE = new Map<string, Promise<Buffer>>();

function binaryPayloadEvidence(buffer: Buffer) {
	const serializer = buffer.length >= 2 && buffer[0] === 0x04 && buffer[1] === 0x08 ? "marshal" : "binary";
	return {
		serializer,
		unsupportedSerializer: true,
		bytes: buffer.length,
		sha256: sha256Hex(buffer),
		hex: buffer.toString("hex"),
		base64: buffer.toString("base64"),
	};
}

function decodedTextCandidates(value: string): Array<{ text: string; urlEncoded: boolean }> {
	const candidates = [{ text: value, urlEncoded: false }];
	try {
		const decoded = decodeURIComponent(value);
		if (decoded !== value) candidates.push({ text: decoded, urlEncoded: true });
	} catch {
		/* best-effort rails URL decoding */
	}
	return candidates;
}

function strictBase64Decode(value: string, encoding: "base64" | "base64url"): Buffer | undefined {
	if (!value) return undefined;
	if (encoding === "base64url") {
		if (/[+/=]/.test(value) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
		const decoded = base64UrlDecode(value);
		return decoded && base64UrlEncode(decoded) === value ? decoded : undefined;
	}
	if (/[-_]/.test(value) || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.toString("base64") === value ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function decodeRailsPayload(context: RailsTokenHelpers, value: string, preferredEncodings: Array<"base64" | "base64url"> = ["base64", "base64url"]) {
	let fallback = { encoding: "raw", urlEncoded: false, text: value, json: undefined as unknown };
	for (const candidate of decodedTextCandidates(value)) {
		fallback = { encoding: "raw", urlEncoded: candidate.urlEncoded, text: candidate.text, json: undefined };
		const rawJson = tryJson(candidate.text);
		if (rawJson !== undefined) return { encoding: "raw", urlEncoded: candidate.urlEncoded, text: candidate.text, json: rawJson };
		for (const encoding of preferredEncodings) {
			const buffer = strictBase64Decode(candidate.text, encoding);
			if (!buffer) continue;
			const printable = context.decodePrintableJsonValue(buffer);
			if (printable.text) return { encoding, urlEncoded: candidate.urlEncoded, text: printable.text, json: printable.json };
			if (buffer.length) return { encoding, urlEncoded: candidate.urlEncoded, text: undefined, json: undefined, binary: binaryPayloadEvidence(buffer) };
		}
	}
	return fallback;
}

function encodeRailsPart(value: Buffer | string, encoding: string, urlEncoded: boolean): string {
	const raw = encoding === "base64url"
		? base64UrlEncode(value)
		: encoding === "base64" || Buffer.isBuffer(value)
			? Buffer.from(value).toString("base64")
			: value;
	return urlEncoded ? encodeURIComponent(raw) : raw;
}

function decodeRailsBufferPart(value: string) {
	for (const candidate of decodedTextCandidates(value)) {
		for (const encoding of ["base64", "base64url"] as const) {
			const bytes = strictBase64Decode(candidate.text, encoding);
			if (bytes) return { bytes, encoding, urlEncoded: candidate.urlEncoded };
		}
	}
	return undefined;
}

function railsExpiryMetadata(value: unknown) {
	if (value === undefined || value === null || value === "") return { expiresAt: undefined, expired: undefined, raw: value };
	const numeric = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const text = asString(value);
	const parsed = numeric !== undefined
		? new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
		: text && /^\d+$/.test(text)
			? new Date(Number(text) > 1_000_000_000_000 ? Number(text) : Number(text) * 1000)
			: text
				? new Date(text)
				: undefined;
	if (!parsed || Number.isNaN(parsed.getTime())) return { expiresAt: text, expired: undefined, raw: value };
	return { expiresAt: parsed.toISOString(), expired: parsed.getTime() <= Date.now(), raw: value };
}

function unwrapRawRailsPlaintext(plaintext: Buffer, decoded: ReturnType<RailsTokenHelpers["decodePrintableJsonValue"]>) {
	const binary = decoded.text === undefined && plaintext.length ? binaryPayloadEvidence(plaintext) : undefined;
	return {
		wrapper: binary?.serializer === "marshal" ? "marshal" as const : "raw" as const,
		plaintextText: decoded.text,
		plaintextJson: decoded.json,
		plaintextBytes: plaintext.length,
		plaintextSha256: sha256Hex(plaintext),
		payload: decoded.json ?? decoded.text ?? binary?.hex,
		binary,
		payloadEncoding: binary ? "binary" : "raw",
		payloadUrlEncoded: false,
		serializer: binary?.serializer,
		unsupportedSerializer: binary?.unsupportedSerializer,
	};
}

function unwrapRailsMetadataPlaintext(context: RailsTokenHelpers, plaintext: Buffer, decoded: ReturnType<RailsTokenHelpers["decodePrintableJsonValue"]>, envelope: Record<string, unknown>, railsMetadata: Record<string, unknown>) {
	const wrappedMessage = asString(railsMetadata.message);
	const payload = wrappedMessage ? decodeRailsPayload(context, wrappedMessage, ["base64", "base64url"]) : { encoding: "raw", urlEncoded: false, text: undefined, json: undefined, binary: undefined };
	const payloadRecord = payload as { binary?: unknown; encoding?: unknown; urlEncoded?: unknown; json?: unknown; text?: unknown };
	const payloadBinary = isRecord(payloadRecord.binary) ? payloadRecord.binary : undefined;
	const expiry = railsExpiryMetadata(railsMetadata.exp ?? railsMetadata.expires_at ?? railsMetadata.expiresAt);
	return {
		wrapper: "rails-metadata" as const,
		plaintextText: decoded.text,
		plaintextJson: decoded.json,
		plaintextBytes: plaintext.length,
		plaintextSha256: sha256Hex(plaintext),
		envelope,
		railsMetadata,
		payload: payload.json ?? payload.text ?? asString(payloadBinary?.hex),
		binary: payloadBinary,
		payloadEncoding: payload.encoding,
		payloadUrlEncoded: payload.urlEncoded,
		serializer: asString(payloadBinary?.serializer),
		unsupportedSerializer: payloadBinary?.unsupportedSerializer === true,
		metadata: {
			wrapped: true,
			purpose: asString(railsMetadata.pur ?? railsMetadata.purpose),
			expiresAt: expiry.expiresAt,
			expiresAtRaw: expiry.raw,
			expired: expiry.expired,
			messageEncoding: payload.encoding,
			messageUrlEncoded: payload.urlEncoded,
			serializer: asString(payloadBinary?.serializer),
			unsupportedSerializer: payloadBinary?.unsupportedSerializer === true || undefined,
		},
	};
}

function unwrapRailsEncryptedPlaintext(context: RailsTokenHelpers, plaintext: Buffer) {
	const decoded = context.decodePrintableJsonValue(plaintext);
	const envelope = isRecord(decoded.json) ? decoded.json : undefined;
	const railsMetadata = envelope && isRecord(envelope._rails) ? envelope._rails : undefined;
	return envelope && railsMetadata
		? unwrapRailsMetadataPlaintext(context, plaintext, decoded, envelope, railsMetadata)
		: unwrapRawRailsPlaintext(plaintext, decoded);
}

function wrapRailsEncryptedPlaintext(payload: Record<string, unknown>, decoded: ReturnType<typeof unwrapRailsEncryptedPlaintext>) {
	if (decoded.wrapper !== "rails-metadata") return Buffer.from(JSON.stringify(payload), "utf8");
	const railsMetadata = isRecord(decoded.railsMetadata) ? { ...decoded.railsMetadata } : {};
	railsMetadata.message = encodeRailsPart(JSON.stringify(payload), decoded.payloadEncoding || "base64", Boolean(decoded.payloadUrlEncoded));
	const envelope = isRecord(decoded.envelope) ? { ...decoded.envelope } : {};
	envelope._rails = railsMetadata;
	return Buffer.from(JSON.stringify(envelope), "utf8");
}

function parseRailsEncryptedToken(token: string) {
	const parts = token.split("--");
	if (parts.length !== 3) return undefined;
	const ciphertext = decodeRailsBufferPart(parts[0]);
	const iv = decodeRailsBufferPart(parts[1]);
	const authTag = decodeRailsBufferPart(parts[2]);
	if (!ciphertext?.bytes.length || iv?.bytes.length !== 12 || authTag?.bytes.length !== 16) return undefined;
	return { ciphertext: { ...ciphertext, raw: parts[0] }, iv: { ...iv, raw: parts[1] }, authTag: { ...authTag, raw: parts[2] } };
}

function parseRailsLegacyCbcPayload(value: string) {
	for (const candidate of decodedTextCandidates(value)) {
		const parts = candidate.text.split("--");
		if (parts.length !== 2) continue;
		const ciphertext = decodeRailsBufferPart(parts[0]);
		const iv = decodeRailsBufferPart(parts[1]);
		if (!ciphertext?.bytes.length || iv?.bytes.length !== 16) continue;
		return { ciphertext: { ...ciphertext, raw: parts[0] }, iv: { ...iv, raw: parts[1] }, urlEncoded: candidate.urlEncoded };
	}
	return undefined;
}

function addRailsKeyVariant<T extends SignatureVariant | RailsEncryptionVariant>(out: T[], seen: Set<string>, variant: T) {
	const key = `${variant.derivation || ""}:${variant.digest || ""}:${variant.keySource}:${variant.salt || ""}:${variant.keyBytes.toString("hex")}`;
	if (seen.has(key)) return;
	seen.add(key);
	out.push(variant);
}

function deriveRailsPbkdf2Key(secret: string, salt: string, digest: SignatureVariant["digest"], keyLength: number): Promise<Buffer> {
	const key = `${digest}:${salt}:${keyLength}:${secret}`;
	const cached = RAILS_PBKDF2_CACHE.get(key);
	if (cached) return cached;
	const created = new Promise<Buffer>((resolve, reject) => {
		pbkdf2(secret, salt, 1000, keyLength, digest, (error, derived) => error ? reject(error) : resolve(derived));
	});
	RAILS_PBKDF2_CACHE.set(key, created);
	return created;
}

async function railsSignatureVariants(context: RailsTokenHelpers, secret: string): Promise<SignatureVariant[]> {
	const variants: SignatureVariant[] = [];
	const seen = new Set<string>();
	for (const digest of ["sha1", "sha256"] as const) {
		for (const candidate of context.secretByteCandidates(secret)) addRailsKeyVariant(variants, seen, { digest, keySource: candidate.source, keyBytes: candidate.bytes, keyLength: candidate.bytes.length, derivation: "direct" });
		for (const salt of ["signed cookie", "action_dispatch.signed_cookie_salt", "signed encrypted cookie", "action_dispatch.encrypted_signed_cookie_salt"]) {
			addRailsKeyVariant(variants, seen, { digest, keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest, 64), keyLength: 64, salt, derivation: "pbkdf2" });
		}
	}
	return variants;
}

async function railsEncryptionVariants(context: RailsTokenHelpers, secret: string, cipher: RailsEncryptionVariant["cipher"], salts: readonly string[]): Promise<RailsEncryptionVariant[]> {
	const variants: RailsEncryptionVariant[] = [];
	const seen = new Set<string>();
	for (const candidate of context.secretByteCandidates(secret)) {
		if (candidate.bytes.length === 32) addRailsKeyVariant(variants, seen, { cipher, keySource: candidate.source, keyBytes: candidate.bytes, keyLength: candidate.bytes.length, derivation: "direct" });
	}
	for (const digest of ["sha1", "sha256"] as const) {
		for (const salt of salts) {
			addRailsKeyVariant(variants, seen, { cipher, keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest, 32), keyLength: 32, derivation: "pbkdf2", digest, salt });
		}
	}
	return variants;
}

async function railsKeyFromMatch(context: RailsTokenHelpers, secret: string, match: SecretMatch, defaults: { salt: string; keyLength: number }) {
	const derivation = asString(match.derivation) || "direct";
	if (derivation === "pbkdf2") {
		return deriveRailsPbkdf2Key(secret, asString(match.salt) || defaults.salt, (asString(match.digest) || "sha1") as SignatureVariant["digest"], Number(match.keyLength) || defaults.keyLength);
	}
	const keySource = asString(match.keySource) || "utf8";
	if (keySource === "utf8") return Buffer.from(secret, "utf8");
	return context.secretByteCandidates(secret).find((item) => item.source === keySource && item.bytes.length === (Number(match.keyLength) || defaults.keyLength))?.bytes
		|| context.secretByteCandidates(secret).find((item) => item.bytes.length === (Number(match.keyLength) || defaults.keyLength))?.bytes;
}

async function verifyRailsEncryptedToken(context: RailsTokenHelpers, token: string, secrets: string[]) {
	const parsed = parseRailsEncryptedToken(token);
	if (!parsed) return undefined;
	const matches: SecretMatch[] = [];
	let decrypted: ReturnType<typeof unwrapRailsEncryptedPlaintext> | undefined;
	let testedKeyVariantCount = 0;
	for (let i = 0; i < secrets.length; i += 1) {
		for (const variant of await railsEncryptionVariants(context, secrets[i], "aes-256-gcm", ["authenticated encrypted cookie", "action_dispatch.authenticated_encrypted_cookie_salt"])) {
			testedKeyVariantCount += 1;
			try {
				const decipher = createDecipheriv(variant.cipher, variant.keyBytes, parsed.iv.bytes) as ReturnType<typeof createDecipheriv> & { setAuthTag(tag: Buffer): void };
				decipher.setAuthTag(parsed.authTag.bytes);
				const plaintext = Buffer.concat([decipher.update(parsed.ciphertext.bytes), decipher.final()]);
				decrypted ||= unwrapRailsEncryptedPlaintext(context, plaintext);
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), keySource: variant.keySource, keyLength: variant.keyLength, derivation: variant.derivation, digest: variant.digest, salt: variant.salt, cipher: variant.cipher, plaintextBytes: plaintext.length });
				break;
			} catch {
				/* best-effort rails encrypted token decryption candidate probe */
			}
		}
	}
	return {
		parsed,
		decrypted,
		matches,
		testedSecretCandidateCount: secrets.length,
		testedKeyVariantCount,
		truncatedKeyVariantCount: 0,
	};
}

async function verifyRailsSignedToken(context: RailsTokenHelpers, token: string, secrets: string[]) {
	const splitAt = token.lastIndexOf("--");
	if (splitAt <= 0) return undefined;
	const payloadPart = token.slice(0, splitAt);
	const signaturePart = token.slice(splitAt + 2).toLowerCase();
	if (!/^[a-f0-9]+$/i.test(signaturePart)) return undefined;
	const matches: SecretMatch[] = [];
	for (let i = 0; i < secrets.length; i += 1) {
		for (const variant of await railsSignatureVariants(context, secrets[i])) {
			const expected = createHmac(variant.digest, variant.keyBytes).update(payloadPart, "utf8").digest("hex");
			if (expected === signaturePart) {
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), digest: variant.digest, salt: variant.salt, derivation: variant.derivation, keySource: variant.keySource, keyLength: variant.keyLength });
				break;
			}
		}
	}
	return {
		payloadPart,
		signaturePart,
		decoded: decodeRailsPayload(context, payloadPart),
		matches,
		testedSecretCandidateCount: secrets.length,
	};
}

async function verifyRailsLegacyCbcPayload(context: RailsTokenHelpers, payloadPart: string, signedMatches: SecretMatch[], signedTestedSecretCandidateCount: number) {
	const parsed = parseRailsLegacyCbcPayload(payloadPart);
	if (!parsed || !signedMatches.length) return undefined;
	const matches: SecretMatch[] = [];
	let decrypted: ReturnType<typeof unwrapRailsEncryptedPlaintext> | undefined;
	let testedKeyVariantCount = 0;
	for (const signedMatch of signedMatches) {
		const secret = asString(signedMatch.secret);
		if (!secret) continue;
		for (const variant of await railsEncryptionVariants(context, secret, "aes-256-cbc", ["encrypted cookie", "action_dispatch.encrypted_cookie_salt"])) {
			testedKeyVariantCount += 1;
			try {
				const decipher = createDecipheriv("aes-256-cbc", variant.keyBytes, parsed.iv.bytes);
				const plaintext = Buffer.concat([decipher.update(parsed.ciphertext.bytes), decipher.final()]);
				decrypted ||= unwrapRailsEncryptedPlaintext(context, plaintext);
				matches.push({
					index: signedMatch.index,
					secret,
					secretSha256: signedMatch.secretSha256,
					keySource: variant.keySource,
					keyLength: variant.keyLength,
					derivation: variant.derivation,
					digest: variant.digest,
					salt: variant.salt,
					cipher: variant.cipher,
					plaintextBytes: plaintext.length,
					signedDigest: signedMatch.digest,
					signedSalt: signedMatch.salt,
					signedDerivation: signedMatch.derivation,
					signedKeySource: signedMatch.keySource,
					signedKeyLength: signedMatch.keyLength,
				});
				break;
			} catch {
				/* best-effort rails legacy CBC decryption candidate probe */
			}
		}
	}
	return {
		parsed,
		decrypted,
		matches,
		testedSecretCandidateCount: signedTestedSecretCandidateCount,
		testedKeyVariantCount,
		truncatedKeyVariantCount: 0,
	};
}

async function signRailsSignedToken(context: RailsTokenHelpers, payload: Record<string, unknown> | string, secret: string, match: SecretMatch, encoding: string, urlEncoded: boolean): Promise<string | undefined> {
	const payloadPart = typeof payload === "string" ? payload : encodeRailsPart(JSON.stringify(payload), encoding, urlEncoded);
	const digest = (asString(match.digest) || "sha1") as SignatureVariant["digest"];
	const key = await railsKeyFromMatch(context, secret, match, { salt: "signed cookie", keyLength: 64 });
	if (!key) return undefined;
	const signature = createHmac(digest, key).update(payloadPart, "utf8").digest("hex");
	return `${payloadPart}--${signature}`;
}

async function encryptRailsToken(context: RailsTokenHelpers, payload: Record<string, unknown>, secret: string, match: SecretMatch, parsed: NonNullable<Awaited<ReturnType<typeof verifyRailsEncryptedToken>>>): Promise<string | undefined> {
	const key = await railsKeyFromMatch(context, secret, match, { salt: "authenticated encrypted cookie", keyLength: 32 });
	if (!key || !parsed.decrypted) return undefined;
	const plaintext = wrapRailsEncryptedPlaintext(payload, parsed.decrypted);
	const cipherName = (asString(match.cipher) || "aes-256-gcm") as "aes-256-gcm";
	const iv = randomBytes(parsed.parsed.iv.bytes.length || 12);
	const cipher = createCipheriv(cipherName, key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return `${encodeRailsPart(ciphertext, parsed.parsed.ciphertext.encoding, parsed.parsed.ciphertext.urlEncoded)}--${encodeRailsPart(iv, parsed.parsed.iv.encoding, parsed.parsed.iv.urlEncoded)}--${encodeRailsPart(authTag, parsed.parsed.authTag.encoding, parsed.parsed.authTag.urlEncoded)}`;
}

async function encryptRailsLegacyCbcToken(context: RailsTokenHelpers, payload: Record<string, unknown>, secret: string, match: SecretMatch, legacy: NonNullable<Awaited<ReturnType<typeof verifyRailsLegacyCbcPayload>>>): Promise<string | undefined> {
	const key = await railsKeyFromMatch(context, secret, match, { salt: "encrypted cookie", keyLength: 32 });
	if (!key || !legacy.decrypted) return undefined;
	const plaintext = wrapRailsEncryptedPlaintext(payload, legacy.decrypted);
	const iv = randomBytes(legacy.parsed.iv.bytes.length || 16);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const payloadPart = `${encodeRailsPart(ciphertext, legacy.parsed.ciphertext.encoding, legacy.parsed.ciphertext.urlEncoded)}--${encodeRailsPart(iv, legacy.parsed.iv.encoding, legacy.parsed.iv.urlEncoded)}`;
	return signRailsSignedToken(context, payloadPart, secret, {
		digest: match.signedDigest,
		salt: match.signedSalt,
		derivation: match.signedDerivation,
		keySource: match.signedKeySource,
		keyLength: match.signedKeyLength,
	}, "raw", false);
}

export function createRailsCookieTokenFns(context: RailsTokenHelpers) {
	return {
		verifyRailsEncryptedToken: verifyRailsEncryptedToken.bind(null, context),
		verifyRailsSignedToken: verifyRailsSignedToken.bind(null, context),
		verifyRailsLegacyCbcPayload: verifyRailsLegacyCbcPayload.bind(null, context),
		signRailsSignedToken: signRailsSignedToken.bind(null, context),
		encryptRailsToken: encryptRailsToken.bind(null, context),
		encryptRailsLegacyCbcToken: encryptRailsLegacyCbcToken.bind(null, context),
	};
}
