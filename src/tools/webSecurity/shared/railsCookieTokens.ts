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

export function createRailsCookieTokenFns(helpers: RailsTokenHelpers) {
	const { decodePrintableJsonValue, secretByteCandidates } = helpers;

	function decodedTextCandidates(value: string): Array<{ text: string; urlEncoded: boolean }> {
		const candidates = [{ text: value, urlEncoded: false }];
		try {
			const decoded = decodeURIComponent(value);
			if (decoded !== value) candidates.push({ text: decoded, urlEncoded: true });
		} catch {}
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

	function decodeRailsPayload(value: string, preferredEncodings: Array<"base64" | "base64url"> = ["base64", "base64url"]) {
		let fallback = { encoding: "raw", urlEncoded: false, text: value, json: undefined as unknown };
		for (const candidate of decodedTextCandidates(value)) {
			fallback = { encoding: "raw", urlEncoded: candidate.urlEncoded, text: candidate.text, json: undefined };
			const rawJson = tryJson(candidate.text);
			if (rawJson !== undefined) return { encoding: "raw", urlEncoded: candidate.urlEncoded, text: candidate.text, json: rawJson };
			for (const encoding of preferredEncodings) {
				const buffer = strictBase64Decode(candidate.text, encoding);
				if (!buffer) continue;
				const printable = decodePrintableJsonValue(buffer);
				if (printable.text) return { encoding, urlEncoded: candidate.urlEncoded, text: printable.text, json: printable.json };
				if (buffer.length) return { encoding, urlEncoded: candidate.urlEncoded, text: undefined, json: undefined, binary: binaryPayloadEvidence(buffer) };
			}
		}
		return fallback;
	}

	function encodeRailsPayload(value: Record<string, unknown>, encoding: string, urlEncoded: boolean): string {
		const json = JSON.stringify(value);
		let raw = encoding === "base64url" ? base64UrlEncode(json) : encoding === "base64" ? Buffer.from(json, "utf8").toString("base64") : json;
		if (urlEncoded) raw = encodeURIComponent(raw);
		return raw;
	}

	function encodeRailsBufferPart(buffer: Buffer, encoding: string, urlEncoded: boolean): string {
		let raw = encoding === "base64url" ? base64UrlEncode(buffer) : buffer.toString("base64");
		if (urlEncoded) raw = encodeURIComponent(raw);
		return raw;
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

	function unwrapRailsEncryptedPlaintext(plaintext: Buffer) {
		const decoded = decodePrintableJsonValue(plaintext);
		const envelope = isRecord(decoded.json) ? decoded.json : undefined;
		const railsMetadata = envelope && isRecord(envelope._rails) ? envelope._rails : undefined;
		if (!railsMetadata) {
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
		const wrappedMessage = asString(railsMetadata.message);
		const payload = wrappedMessage ? decodeRailsPayload(wrappedMessage, ["base64", "base64url"]) : { encoding: "raw", urlEncoded: false, text: undefined, json: undefined, binary: undefined };
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

	function wrapRailsEncryptedPlaintext(payload: Record<string, unknown>, decoded: ReturnType<typeof unwrapRailsEncryptedPlaintext>) {
		if (decoded.wrapper !== "rails-metadata") return Buffer.from(JSON.stringify(payload), "utf8");
		const railsMetadata = isRecord(decoded.railsMetadata) ? { ...decoded.railsMetadata } : {};
		railsMetadata.message = encodeRailsPayload(payload, decoded.payloadEncoding || "base64", Boolean(decoded.payloadUrlEncoded));
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

	type RailsEncryptedVariant = {
		cipher: "aes-256-gcm";
		keySource: string;
		keyBytes: Buffer;
		keyLength: number;
		derivation: "direct" | "pbkdf2";
		digest?: SignatureVariant["digest"];
		salt?: string;
	};

	type RailsLegacyCbcVariant = {
		cipher: "aes-256-cbc";
		keySource: string;
		keyBytes: Buffer;
		keyLength: number;
		derivation: "direct" | "pbkdf2";
		digest?: SignatureVariant["digest"];
		salt?: string;
	};

	function uniqueRailsEncryptedVariant(out: RailsEncryptedVariant[], seen: Set<string>, variant: RailsEncryptedVariant) {
		const key = `${variant.derivation}:${variant.keySource}:${variant.digest || ""}:${variant.salt || ""}:${variant.keyBytes.toString("hex")}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(variant);
	}

	function uniqueRailsLegacyCbcVariant(out: RailsLegacyCbcVariant[], seen: Set<string>, variant: RailsLegacyCbcVariant) {
		const key = `${variant.derivation}:${variant.keySource}:${variant.digest || ""}:${variant.salt || ""}:${variant.keyBytes.toString("hex")}`;
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

	async function railsSignatureVariants(secret: string): Promise<SignatureVariant[]> {
		const variants: SignatureVariant[] = [];
		const seen = new Set<string>();
		const add = (variant: SignatureVariant) => {
			const key = `${variant.digest}:${variant.keySource}:${variant.derivation || ""}:${variant.salt || ""}:${variant.keyBytes.toString("hex")}`;
			if (seen.has(key)) return;
			seen.add(key);
			variants.push(variant);
		};
		for (const digest of ["sha1", "sha256"] as const) {
			for (const candidate of secretByteCandidates(secret)) add({ digest, keySource: candidate.source, keyBytes: candidate.bytes, keyLength: candidate.bytes.length, derivation: "direct" });
			for (const salt of ["signed cookie", "action_dispatch.signed_cookie_salt", "signed encrypted cookie", "action_dispatch.encrypted_signed_cookie_salt"]) {
				add({ digest, keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest, 64), keyLength: 64, salt, derivation: "pbkdf2" });
			}
		}
		return variants;
	}

	async function railsEncryptedVariants(secret: string): Promise<RailsEncryptedVariant[]> {
		const variants: RailsEncryptedVariant[] = [];
		const seen = new Set<string>();
		for (const candidate of secretByteCandidates(secret)) {
			if (candidate.bytes.length === 32) uniqueRailsEncryptedVariant(variants, seen, { cipher: "aes-256-gcm", keySource: candidate.source, keyBytes: candidate.bytes, keyLength: candidate.bytes.length, derivation: "direct" });
		}
		for (const digest of ["sha1", "sha256"] as const) {
			for (const salt of ["authenticated encrypted cookie", "action_dispatch.authenticated_encrypted_cookie_salt"]) {
				uniqueRailsEncryptedVariant(variants, seen, { cipher: "aes-256-gcm", keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest, 32), keyLength: 32, derivation: "pbkdf2", digest, salt });
			}
		}
		return variants;
	}

	async function railsLegacyCbcVariants(secret: string): Promise<RailsLegacyCbcVariant[]> {
		const variants: RailsLegacyCbcVariant[] = [];
		const seen = new Set<string>();
		for (const candidate of secretByteCandidates(secret)) {
			if (candidate.bytes.length === 32) uniqueRailsLegacyCbcVariant(variants, seen, { cipher: "aes-256-cbc", keySource: candidate.source, keyBytes: candidate.bytes, keyLength: candidate.bytes.length, derivation: "direct" });
		}
		for (const digest of ["sha1", "sha256"] as const) {
			for (const salt of ["encrypted cookie", "action_dispatch.encrypted_cookie_salt"]) {
				uniqueRailsLegacyCbcVariant(variants, seen, { cipher: "aes-256-cbc", keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest, 32), keyLength: 32, derivation: "pbkdf2", digest, salt });
			}
		}
		return variants;
	}

	async function railsKeyFromMatch(secret: string, match: SecretMatch, defaults: { salt: string; keyLength: number }) {
		const derivation = asString(match.derivation) || "direct";
		if (derivation === "pbkdf2") {
			return deriveRailsPbkdf2Key(secret, asString(match.salt) || defaults.salt, (asString(match.digest) || "sha1") as SignatureVariant["digest"], Number(match.keyLength) || defaults.keyLength);
		}
		const keySource = asString(match.keySource) || "utf8";
		if (keySource === "utf8") return Buffer.from(secret, "utf8");
		return secretByteCandidates(secret).find((item) => item.source === keySource && item.bytes.length === (Number(match.keyLength) || defaults.keyLength))?.bytes
			|| secretByteCandidates(secret).find((item) => item.bytes.length === (Number(match.keyLength) || defaults.keyLength))?.bytes;
	}

	async function verifyRailsEncryptedToken(token: string, secrets: string[]) {
		const parsed = parseRailsEncryptedToken(token);
		if (!parsed) return undefined;
		const matches: SecretMatch[] = [];
		let decrypted: ReturnType<typeof unwrapRailsEncryptedPlaintext> | undefined;
		let testedKeyVariantCount = 0;
		for (let i = 0; i < secrets.length; i += 1) {
			for (const variant of await railsEncryptedVariants(secrets[i])) {
				testedKeyVariantCount += 1;
				try {
					const decipher = createDecipheriv(variant.cipher, variant.keyBytes, parsed.iv.bytes);
					decipher.setAuthTag(parsed.authTag.bytes);
					const plaintext = Buffer.concat([decipher.update(parsed.ciphertext.bytes), decipher.final()]);
					decrypted ||= unwrapRailsEncryptedPlaintext(plaintext);
					matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), keySource: variant.keySource, keyLength: variant.keyLength, derivation: variant.derivation, digest: variant.digest, salt: variant.salt, cipher: variant.cipher, plaintextBytes: plaintext.length });
					break;
				} catch {}
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

	async function verifyRailsSignedToken(token: string, secrets: string[]) {
		const splitAt = token.lastIndexOf("--");
		if (splitAt <= 0) return undefined;
		const payloadPart = token.slice(0, splitAt);
		const signaturePart = token.slice(splitAt + 2).toLowerCase();
		if (!/^[a-f0-9]+$/i.test(signaturePart)) return undefined;
		const matches: SecretMatch[] = [];
		for (let i = 0; i < secrets.length; i += 1) {
			for (const variant of await railsSignatureVariants(secrets[i])) {
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
			decoded: decodeRailsPayload(payloadPart),
			matches,
			testedSecretCandidateCount: secrets.length,
		};
	}

	async function verifyRailsLegacyCbcPayload(payloadPart: string, signedMatches: SecretMatch[], signedTestedSecretCandidateCount: number) {
		const parsed = parseRailsLegacyCbcPayload(payloadPart);
		if (!parsed || !signedMatches.length) return undefined;
		const matches: SecretMatch[] = [];
		let decrypted: ReturnType<typeof unwrapRailsEncryptedPlaintext> | undefined;
		let testedKeyVariantCount = 0;
		for (const signedMatch of signedMatches) {
			const secret = asString(signedMatch.secret);
			if (!secret) continue;
			for (const variant of await railsLegacyCbcVariants(secret)) {
				testedKeyVariantCount += 1;
				try {
					const decipher = createDecipheriv("aes-256-cbc", variant.keyBytes, parsed.iv.bytes);
					const plaintext = Buffer.concat([decipher.update(parsed.ciphertext.bytes), decipher.final()]);
					decrypted ||= unwrapRailsEncryptedPlaintext(plaintext);
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
				} catch {}
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

	async function signRailsSignedToken(payload: Record<string, unknown> | string, secret: string, match: SecretMatch, encoding: string, urlEncoded: boolean): Promise<string | undefined> {
		const payloadPart = typeof payload === "string" ? payload : encodeRailsPayload(payload, encoding, urlEncoded);
		const digest = (asString(match.digest) || "sha1") as SignatureVariant["digest"];
		const key = await railsKeyFromMatch(secret, match, { salt: "signed cookie", keyLength: 64 });
		if (!key) return undefined;
		const signature = createHmac(digest, key).update(payloadPart, "utf8").digest("hex");
		return `${payloadPart}--${signature}`;
	}

	async function encryptRailsToken(payload: Record<string, unknown>, secret: string, match: SecretMatch, parsed: NonNullable<Awaited<ReturnType<typeof verifyRailsEncryptedToken>>>): Promise<string | undefined> {
		const key = await railsKeyFromMatch(secret, match, { salt: "authenticated encrypted cookie", keyLength: 32 });
		if (!key || !parsed.decrypted) return undefined;
		const plaintext = wrapRailsEncryptedPlaintext(payload, parsed.decrypted);
		const cipherName = (asString(match.cipher) || "aes-256-gcm") as "aes-256-gcm";
		const iv = randomBytes(parsed.parsed.iv.bytes.length || 12);
		const cipher = createCipheriv(cipherName, key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const authTag = cipher.getAuthTag();
		return `${encodeRailsBufferPart(ciphertext, parsed.parsed.ciphertext.encoding, parsed.parsed.ciphertext.urlEncoded)}--${encodeRailsBufferPart(iv, parsed.parsed.iv.encoding, parsed.parsed.iv.urlEncoded)}--${encodeRailsBufferPart(authTag, parsed.parsed.authTag.encoding, parsed.parsed.authTag.urlEncoded)}`;
	}

	async function encryptRailsLegacyCbcToken(payload: Record<string, unknown>, secret: string, match: SecretMatch, legacy: NonNullable<Awaited<ReturnType<typeof verifyRailsLegacyCbcPayload>>>): Promise<string | undefined> {
		const key = await railsKeyFromMatch(secret, match, { salt: "encrypted cookie", keyLength: 32 });
		if (!key || !legacy.decrypted) return undefined;
		const plaintext = wrapRailsEncryptedPlaintext(payload, legacy.decrypted);
		const iv = randomBytes(legacy.parsed.iv.bytes.length || 16);
		const cipher = createCipheriv("aes-256-cbc", key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const payloadPart = `${encodeRailsBufferPart(ciphertext, legacy.parsed.ciphertext.encoding, legacy.parsed.ciphertext.urlEncoded)}--${encodeRailsBufferPart(iv, legacy.parsed.iv.encoding, legacy.parsed.iv.urlEncoded)}`;
		return signRailsSignedToken(payloadPart, secret, {
			digest: match.signedDigest,
			salt: match.signedSalt,
			derivation: match.signedDerivation,
			keySource: match.signedKeySource,
			keyLength: match.signedKeyLength,
		}, "raw", false);
	}

	return {
		verifyRailsEncryptedToken,
		verifyRailsSignedToken,
		verifyRailsLegacyCbcPayload,
		signRailsSignedToken,
		encryptRailsToken,
		encryptRailsLegacyCbcToken,
	};
}
