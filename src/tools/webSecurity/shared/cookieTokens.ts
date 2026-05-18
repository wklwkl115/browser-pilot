import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import { asString, base64UrlDecode, base64UrlEncode, isRecord, printableText, sha256Hex, tryJson } from "./normalize";

type CookieSample = { source: string; name?: string; value: string; attributes?: Record<string, string | boolean> };

type SecretMatch = Record<string, unknown>;

type SignatureVariant = {
	digest: "sha1" | "sha256" | "sha384" | "sha512";
	keySource: string;
	keyBytes: Buffer;
	salt?: string;
	derivation?: string;
};

const JWT_HMAC_ALGS: Record<string, "sha256" | "sha384" | "sha512"> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
const JWE_DIRECT_ALGS: Record<string, { cipher: string; keyBytes: number }> = {
	A128GCM: { cipher: "aes-128-gcm", keyBytes: 16 },
	A192GCM: { cipher: "aes-192-gcm", keyBytes: 24 },
	A256GCM: { cipher: "aes-256-gcm", keyBytes: 32 },
};
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RAILS_PBKDF2_CACHE = new Map<string, Promise<Buffer>>();

function base64UrlNoPad(value: Buffer): string {
	return base64UrlEncode(value).replace(/=+$/g, "");
}

function decodePrintableJsonValue(buffer: Buffer): { text?: string; json?: unknown } {
	const text = printableText(buffer);
	if (!text) return {};
	return { text, json: tryJson(text) };
}

function secretByteCandidates(secret: string): Array<{ source: string; bytes: Buffer }> {
	const out: Array<{ source: string; bytes: Buffer }> = [];
	const seen = new Set<string>();
	const add = (source: string, bytes: Buffer | undefined) => {
		if (!bytes?.length) return;
		const key = `${source}:${bytes.toString("hex")}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ source, bytes });
	};
	add("utf8", Buffer.from(secret, "utf8"));
	if (/^[a-f0-9]+$/i.test(secret) && secret.length % 2 === 0) add("hex", Buffer.from(secret, "hex"));
	if (/^[A-Za-z0-9_-]+$/.test(secret)) add("base64url", base64UrlDecode(secret));
	if (/^[A-Za-z0-9+/=]+$/.test(secret) && secret.length % 4 !== 1) {
		try { add("base64", Buffer.from(secret, "base64")); } catch {}
	}
	return out;
}

function parseJwt(token: string) {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const header = decodePrintableJsonValue(base64UrlDecode(parts[0]) || Buffer.alloc(0));
	const payload = decodePrintableJsonValue(base64UrlDecode(parts[1]) || Buffer.alloc(0));
	if (!isRecord(header.json) || !isRecord(payload.json)) return undefined;
	return {
		parts,
		header: header.json,
		payload: payload.json,
		alg: asString((header.json as Record<string, unknown>).alg) || "",
		kid: asString((header.json as Record<string, unknown>).kid),
		typ: asString((header.json as Record<string, unknown>).typ),
		signingInput: `${parts[0]}.${parts[1]}`,
	};
}

function verifyJwtHmac(jwt: NonNullable<ReturnType<typeof parseJwt>>, secrets: string[]) {
	if (!JWT_HMAC_ALGS[jwt.alg]) return { supported: false, matches: [], testedSecretCandidateCount: 0 };
	const signature = base64UrlDecode(jwt.parts[2]) || Buffer.alloc(0);
	const matches: SecretMatch[] = [];
	for (let i = 0; i < secrets.length; i += 1) {
		const expected = createHmac(JWT_HMAC_ALGS[jwt.alg], secrets[i]).update(jwt.signingInput).digest();
		if (signature.length === expected.length && timingSafeEqual(signature, expected)) matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), keySource: "utf8" });
	}
	return { supported: true, matches, testedSecretCandidateCount: secrets.length };
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, secret?: string): string | undefined {
	const alg = asString(header.alg) || "";
	const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
	if (alg.toLowerCase() === "none") return `${signingInput}.`;
	const digest = JWT_HMAC_ALGS[alg];
	if (!digest || secret === undefined) return undefined;
	return `${signingInput}.${base64UrlEncode(createHmac(digest, secret).update(signingInput).digest())}`;
}

function parseJwe(token: string) {
	const parts = token.split(".");
	if (parts.length !== 5) return undefined;
	const header = decodePrintableJsonValue(base64UrlDecode(parts[0]) || Buffer.alloc(0));
	if (!isRecord(header.json)) return undefined;
	return {
		parts,
		header: header.json,
		alg: asString((header.json as Record<string, unknown>).alg) || "",
		enc: asString((header.json as Record<string, unknown>).enc) || "",
		kid: asString((header.json as Record<string, unknown>).kid),
		typ: asString((header.json as Record<string, unknown>).typ),
		zip: asString((header.json as Record<string, unknown>).zip),
	};
}

function inflateDeflate(buffer: Buffer): Buffer {
	try {
		return inflateRawSync(buffer);
	} catch {
		return inflateSync(buffer);
	}
}

function decryptDirectJwe(jwe: NonNullable<ReturnType<typeof parseJwe>>, secrets: string[]) {
	const supported = jwe.alg === "dir" && !!JWE_DIRECT_ALGS[jwe.enc] && !jwe.parts[1];
	if (!supported) return { supported: false, matches: [], testedSecretCandidateCount: 0 };
	const spec = JWE_DIRECT_ALGS[jwe.enc];
	const iv = base64UrlDecode(jwe.parts[2]);
	const ciphertext = base64UrlDecode(jwe.parts[3]);
	const tag = base64UrlDecode(jwe.parts[4]);
	if (!iv || !ciphertext || !tag) return { supported: true, matches: [], testedSecretCandidateCount: secrets.length };
	const matches: SecretMatch[] = [];
	for (let i = 0; i < secrets.length; i += 1) {
		for (const candidate of secretByteCandidates(secrets[i])) {
			if (candidate.bytes.length !== spec.keyBytes) continue;
			try {
				const decipher = createDecipheriv(spec.cipher, candidate.bytes, iv);
				decipher.setAAD(Buffer.from(jwe.parts[0], "utf8"));
				decipher.setAuthTag(tag);
				let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
				if (jwe.zip === "DEF") plaintext = inflateDeflate(plaintext);
				const decoded = decodePrintableJsonValue(plaintext);
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), keySource: candidate.source, payload: decoded.json ?? decoded.text, plaintextBytes: plaintext.length });
				break;
			} catch {}
		}
	}
	return { supported: true, matches, testedSecretCandidateCount: secrets.length };
}

function encryptDirectJwe(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string, keySource = "utf8") {
	const alg = asString(header.alg) || "";
	const enc = asString(header.enc) || "";
	const spec = alg === "dir" ? JWE_DIRECT_ALGS[enc] : undefined;
	if (!spec) return undefined;
	const key = secretByteCandidates(secret).find((item) => item.source === keySource && item.bytes.length === spec.keyBytes)?.bytes || secretByteCandidates(secret).find((item) => item.bytes.length === spec.keyBytes)?.bytes;
	if (!key) return undefined;
	const protectedHeader = base64UrlEncode(JSON.stringify(header));
	let plaintext = Buffer.from(JSON.stringify(payload), "utf8");
	if (asString(header.zip) === "DEF") plaintext = deflateRawSync(plaintext);
	const iv = randomBytes(12);
	const cipher = createCipheriv(spec.cipher, key, iv);
	cipher.setAAD(Buffer.from(protectedHeader, "utf8"));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${protectedHeader}..${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(tag)}`;
}

function parsePaseto(token: string) {
	const parts = token.split(".");
	if (parts.length < 3 || parts.length > 4) return undefined;
	if (!/^v[1-4]$/i.test(parts[0])) return undefined;
	if (!/^(?:local|public)$/i.test(parts[1])) return undefined;
	const payload = base64UrlDecode(parts[2]);
	const footer = parts[3] ? base64UrlDecode(parts[3]) : undefined;
	const payloadDecoded = payload ? decodePrintableJsonValue(payload) : {};
	const footerDecoded = footer ? decodePrintableJsonValue(footer) : {};
	return {
		version: parts[0].toLowerCase(),
		purpose: parts[1].toLowerCase(),
		payloadBytes: payload?.length || 0,
		payloadText: payloadDecoded.text,
		payloadJson: payloadDecoded.json,
		footerBytes: footer?.length || 0,
		footerText: footerDecoded.text,
		footerJson: footerDecoded.json,
	};
}

function base62Decode(text: string): number | undefined {
	let out = 0;
	for (const char of text) {
		const index = BASE62.indexOf(char);
		if (index < 0) return undefined;
		out = out * 62 + index;
	}
	return out;
}

function base62Encode(value: number): string {
	let current = Math.max(0, Math.floor(value));
	if (current === 0) return "0";
	let out = "";
	while (current > 0) {
		out = BASE62[current % 62] + out;
		current = Math.floor(current / 62);
	}
	return out;
}

function djangoDerivedKey(secret: string, digest: SignatureVariant["digest"], keySalt: string, derivation: string): Buffer {
	if (derivation === "hash-concat") return createHash(digest).update(`${keySalt}${secret}`, "utf8").digest();
	return createHmac(digest, secret).update(keySalt, "utf8").digest();
}

function djangoSignatureVariants(secret: string): SignatureVariant[] {
	const variants: SignatureVariant[] = [];
	for (const digest of ["sha1", "sha256"] as const) {
		for (const keySalt of ["django.core.signingsigner", "django.core.signing.signer", "django.core.signing"]) {
			for (const derivation of ["hash-concat", "hmac-secret"] as const) variants.push({ digest, keySource: "utf8", keyBytes: djangoDerivedKey(secret, digest, keySalt, derivation), salt: keySalt, derivation });
		}
	}
	return variants;
}

function decodeDjangoPayload(value: string) {
	const compressed = value.startsWith(".");
	const encoded = compressed ? value.slice(1) : value;
	const decoded = base64UrlDecode(encoded);
	if (!decoded) return { compressed, text: undefined, json: undefined };
	const raw = compressed ? inflateDeflate(decoded) : decoded;
	const printable = decodePrintableJsonValue(raw);
	return { compressed, text: printable.text, json: printable.json };
}

function encodeDjangoPayload(value: Record<string, unknown>, compressed: boolean): string {
	const raw = Buffer.from(JSON.stringify(value), "utf8");
	const body = compressed ? deflateRawSync(raw) : raw;
	return `${compressed ? "." : ""}${base64UrlNoPad(body)}`;
}

function verifyDjangoToken(token: string, secrets: string[]) {
	const last = token.lastIndexOf(":");
	const second = token.lastIndexOf(":", last - 1);
	if (last <= 0 || second <= 0) return undefined;
	const payloadPart = token.slice(0, second);
	const timestampPart = token.slice(second + 1, last);
	const signaturePart = token.slice(last + 1);
	if (!/^[0-9A-Za-z]+$/.test(timestampPart) || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) return undefined;
	const matches: SecretMatch[] = [];
	const signedValue = `${payloadPart}:${timestampPart}`;
	for (let i = 0; i < secrets.length; i += 1) {
		for (const variant of djangoSignatureVariants(secrets[i])) {
			const expected = base64UrlNoPad(createHmac(variant.digest, variant.keyBytes).update(signedValue, "utf8").digest());
			if (expected === signaturePart) {
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), digest: variant.digest, salt: variant.salt, derivation: variant.derivation });
				break;
			}
		}
	}
	return {
		payloadPart,
		timestampPart,
		timestamp: base62Decode(timestampPart),
		signaturePart,
		decoded: decodeDjangoPayload(payloadPart),
		matches,
		testedSecretCandidateCount: secrets.length,
	};
}

function signDjangoToken(payload: Record<string, unknown>, timestampPart: string, secret: string, match: SecretMatch, compressed: boolean): string {
	const payloadPart = encodeDjangoPayload(payload, compressed);
	const signedValue = `${payloadPart}:${timestampPart}`;
	const digest = (asString(match.digest) || "sha256") as SignatureVariant["digest"];
	const keySalt = asString(match.salt) || "django.core.signingsigner";
	const derivation = asString(match.derivation) || "hash-concat";
	const key = djangoDerivedKey(secret, digest, keySalt, derivation);
	const signature = base64UrlNoPad(createHmac(digest, key).update(signedValue, "utf8").digest());
	return `${signedValue}:${signature}`;
}

function bytesToInteger(buffer: Buffer): number {
	let out = 0;
	for (const value of buffer.values()) out = out * 256 + value;
	return out;
}

function integerToBytes(value: number): Buffer {
	let hex = Math.max(0, Math.floor(value)).toString(16);
	if (hex.length % 2) hex = `0${hex}`;
	return Buffer.from(hex || "00", "hex");
}

function decodeFlaskPayload(segment: string) {
	const compressed = segment.startsWith(".");
	const encoded = compressed ? segment.slice(1) : segment;
	const decoded = base64UrlDecode(encoded);
	if (!decoded) return { compressed, text: undefined, json: undefined };
	const raw = compressed ? inflateSync(decoded) : decoded;
	const printable = decodePrintableJsonValue(raw);
	return { compressed, text: printable.text, json: printable.json };
}

function encodeFlaskPayload(value: Record<string, unknown>, compressed: boolean): string {
	const raw = Buffer.from(JSON.stringify(value), "utf8");
	const body = compressed ? deflateRawSync(raw) : raw;
	return `${compressed ? "." : ""}${base64UrlNoPad(body)}`;
}

function flaskDerivedKey(secret: string, digest: SignatureVariant["digest"], salt: string, derivation: string): Buffer {
	if (derivation === "django-concat") return createHash(digest).update(`${salt}signer${secret}`, "utf8").digest();
	return createHmac(digest, secret).update(salt, "utf8").digest();
}

function flaskSignatureVariants(secret: string): SignatureVariant[] {
	const variants: SignatureVariant[] = [];
	for (const digest of ["sha1", "sha256"] as const) {
		for (const derivation of ["hmac", "django-concat"] as const) variants.push({ digest, keySource: "utf8", keyBytes: flaskDerivedKey(secret, digest, "cookie-session", derivation), salt: "cookie-session", derivation });
	}
	return variants;
}

function verifyFlaskToken(token: string, secrets: string[]) {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const [payloadPart, timestampPart, signaturePart] = parts;
	const timestampBytes = base64UrlDecode(timestampPart);
	if (!timestampBytes?.length) return undefined;
	const matches: SecretMatch[] = [];
	const signedValue = `${payloadPart}.${timestampPart}`;
	for (let i = 0; i < secrets.length; i += 1) {
		for (const variant of flaskSignatureVariants(secrets[i])) {
			const expected = base64UrlNoPad(createHmac(variant.digest, variant.keyBytes).update(signedValue, "utf8").digest());
			if (expected === signaturePart) {
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), digest: variant.digest, salt: variant.salt, derivation: variant.derivation });
				break;
			}
		}
	}
	return {
		payloadPart,
		timestampPart,
		timestamp: bytesToInteger(timestampBytes),
		signaturePart,
		decoded: decodeFlaskPayload(payloadPart),
		matches,
		testedSecretCandidateCount: secrets.length,
	};
}

function signFlaskToken(payload: Record<string, unknown>, timestampPart: string, secret: string, match: SecretMatch, compressed: boolean): string {
	const payloadPart = encodeFlaskPayload(payload, compressed);
	const signedValue = `${payloadPart}.${timestampPart}`;
	const digest = (asString(match.digest) || "sha1") as SignatureVariant["digest"];
	const salt = asString(match.salt) || "cookie-session";
	const derivation = asString(match.derivation) || "hmac";
	const key = flaskDerivedKey(secret, digest, salt, derivation);
	const signature = base64UrlNoPad(createHmac(digest, key).update(signedValue, "utf8").digest());
	return `${signedValue}.${signature}`;
}

function decodeRailsPayload(value: string) {
	const decodedUrl = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
	const rawJson = tryJson(decodedUrl);
	if (rawJson !== undefined) return { encoding: "raw", urlEncoded: decodedUrl !== value, text: decodedUrl, json: rawJson };
	for (const encoding of ["base64url", "base64"] as const) {
		const buffer = encoding === "base64url" ? base64UrlDecode(decodedUrl) : (() => { try { return Buffer.from(decodedUrl, "base64"); } catch { return undefined; } })();
		const printable = buffer ? decodePrintableJsonValue(buffer) : {};
		if (printable.text) return { encoding, urlEncoded: decodedUrl !== value, text: printable.text, json: printable.json };
	}
	return { encoding: "raw", urlEncoded: decodedUrl !== value, text: decodedUrl, json: undefined };
}

function encodeRailsPayload(value: Record<string, unknown>, encoding: string, urlEncoded: boolean): string {
	const json = JSON.stringify(value);
	let raw = encoding === "base64url" ? base64UrlEncode(json) : encoding === "base64" ? Buffer.from(json, "utf8").toString("base64") : json;
	if (urlEncoded) raw = encodeURIComponent(raw);
	return raw;
}

function deriveRailsPbkdf2Key(secret: string, salt: string, digest: SignatureVariant["digest"]): Promise<Buffer> {
	const key = `${digest}:${salt}:${secret}`;
	const cached = RAILS_PBKDF2_CACHE.get(key);
	if (cached) return cached;
	const created = new Promise<Buffer>((resolve, reject) => {
		pbkdf2(secret, salt, 1000, 64, digest, (error, derived) => error ? reject(error) : resolve(derived));
	});
	RAILS_PBKDF2_CACHE.set(key, created);
	return created;
}

async function railsSignatureVariants(secret: string): Promise<SignatureVariant[]> {
	const variants: SignatureVariant[] = [];
	for (const digest of ["sha1", "sha256"] as const) {
		variants.push({ digest, keySource: "utf8", keyBytes: Buffer.from(secret, "utf8"), derivation: "direct" });
		for (const salt of ["signed cookie", "action_dispatch.signed_cookie_salt"]) {
			variants.push({ digest, keySource: "utf8", keyBytes: await deriveRailsPbkdf2Key(secret, salt, digest), salt, derivation: "pbkdf2" });
		}
	}
	return variants;
}

async function verifyRailsToken(token: string, secrets: string[]) {
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
				matches.push({ index: i, secret: secrets[i], secretSha256: sha256Hex(secrets[i]), digest: variant.digest, salt: variant.salt, derivation: variant.derivation });
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

function signRailsToken(payload: Record<string, unknown>, secret: string, match: SecretMatch, encoding: string, urlEncoded: boolean): string {
	const payloadPart = encodeRailsPayload(payload, encoding, urlEncoded);
	const digest = (asString(match.digest) || "sha1") as SignatureVariant["digest"];
	const derivation = asString(match.derivation) || "direct";
	const key = derivation === "pbkdf2" ? pbkdf2Sync(secret, asString(match.salt) || "signed cookie", 1000, 64, digest) : Buffer.from(secret, "utf8");
	const signature = createHmac(digest, key).update(payloadPart, "utf8").digest("hex");
	return `${payloadPart}--${signature}`;
}

function structuredPayloadClaims(payload: unknown) {
	return isRecord(payload) ? payload : undefined;
}

function mutationRecord(payload: unknown, claimMutations: unknown, build: (claims: Record<string, unknown>) => string | undefined): Record<string, unknown> | undefined {
	if (!isRecord(claimMutations)) return undefined;
	if (!isRecord(payload)) return { claims: claimMutations, error: "Structured payload is unavailable for claim mutation" };
	const claims = { ...payload, ...claimMutations };
	const token = build(claims);
	return token ? { claims: claimMutations, payload: claims, token, tokenSha256: sha256Hex(token) } : { claims: claimMutations, error: "Token format is unsupported or no matching secret was supplied" };
}

function tokenPayload(token: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!isRecord(token)) return undefined;
	return structuredPayloadClaims(token.payload);
}

function tokenVerified(token: Record<string, unknown>): boolean {
	return (isRecord(token.signature) && token.signature.verified === true) || (isRecord(token.decryption) && token.decryption.verified === true);
}

export async function analyzeCookieSample(sample: CookieSample, secrets: string[], claimMutations: unknown): Promise<Record<string, unknown>> {
	const result: Record<string, unknown> = {
		source: sample.source,
		name: sample.name,
		valueLength: sample.value.length,
		valueSha256: sha256Hex(sample.value),
		attributes: sample.attributes,
		decodings: [],
	};

	const jwt = parseJwt(sample.value);
	if (jwt) {
		const verification = verifyJwtHmac(jwt, secrets);
		const signature = {
			present: jwt.parts[2].length > 0,
			bytes: (base64UrlDecode(jwt.parts[2]) || Buffer.alloc(0)).length,
			algorithmSupported: verification.supported,
			testedSecretCandidateCount: verification.testedSecretCandidateCount,
			verified: verification.matches.length > 0 || jwt.alg.toLowerCase() === "none",
			matches: verification.matches,
		};
		const token: Record<string, unknown> = { format: "jwt", alg: jwt.alg, typ: jwt.typ, kid: jwt.kid, header: jwt.header, payload: jwt.payload, signature };
		token.mutation = mutationRecord(jwt.payload, claimMutations, (claims) => signJwt(jwt.header, claims, verification.matches.length ? asString(verification.matches[0].secret) : undefined));
		result.kind = "jwt";
		result.jwt = token;
		result.token = token;
		return result;
	}

	const jwe = parseJwe(sample.value);
	if (jwe) {
		const decryption = decryptDirectJwe(jwe, secrets);
		const matchedPayload = decryption.matches.length ? decryption.matches[0].payload : undefined;
		const token: Record<string, unknown> = {
			format: "jwe",
			alg: jwe.alg,
			enc: jwe.enc,
			typ: jwe.typ,
			kid: jwe.kid,
			header: jwe.header,
			decryption: {
				supported: decryption.supported,
				testedSecretCandidateCount: decryption.testedSecretCandidateCount,
				verified: decryption.matches.length > 0,
				matches: decryption.matches.map((match) => ({ index: match.index, secret: match.secret, secretSha256: match.secretSha256, keySource: match.keySource, plaintextBytes: match.plaintextBytes })),
			},
			payload: matchedPayload,
		};
		token.mutation = mutationRecord(matchedPayload, claimMutations, (claims) => encryptDirectJwe(jwe.header, claims, asString(decryption.matches[0]?.secret) || "", asString(decryption.matches[0]?.keySource) || "utf8"));
		result.kind = "jwe";
		result.jwe = token;
		result.token = token;
		return result;
	}

	const paseto = parsePaseto(sample.value);
	if (paseto) {
		const token: Record<string, unknown> = { format: "paseto", version: paseto.version, purpose: paseto.purpose, payloadBytes: paseto.payloadBytes, footerBytes: paseto.footerBytes };
		if (paseto.payloadJson !== undefined || paseto.payloadText !== undefined) token.payload = paseto.payloadJson ?? paseto.payloadText;
		if (paseto.footerJson !== undefined || paseto.footerText !== undefined) token.footer = paseto.footerJson ?? paseto.footerText;
		token.mutation = isRecord(claimMutations) ? { claims: claimMutations, error: "PASETO mutation requires external key material and is not supported by this analyzer" } : undefined;
		result.kind = "paseto";
		result.paseto = token;
		result.token = token;
		return result;
	}

	const django = verifyDjangoToken(sample.value, secrets);
	if (django) {
		const token: Record<string, unknown> = {
			format: "django",
			payload: django.decoded.json ?? django.decoded.text,
			timestamp: django.timestamp,
			timestampBase62: django.timestampPart,
			compressed: django.decoded.compressed,
			signature: { present: true, algorithmSupported: true, testedSecretCandidateCount: django.testedSecretCandidateCount, verified: django.matches.length > 0, matches: django.matches },
		};
		token.mutation = mutationRecord(token.payload, claimMutations, (claims) => signDjangoToken(claims, django.timestampPart || base62Encode(Math.floor(Date.now() / 1000)), asString(django.matches[0]?.secret) || "", django.matches[0] || {}, django.decoded.compressed));
		result.kind = "django";
		result.sessionToken = token;
		result.token = token;
		return result;
	}

	const flask = verifyFlaskToken(sample.value, secrets);
	if (flask) {
		const token: Record<string, unknown> = {
			format: "flask",
			payload: flask.decoded.json ?? flask.decoded.text,
			timestamp: flask.timestamp,
			timestampBase64: flask.timestampPart,
			compressed: flask.decoded.compressed,
			signature: { present: true, algorithmSupported: true, testedSecretCandidateCount: flask.testedSecretCandidateCount, verified: flask.matches.length > 0, matches: flask.matches },
		};
		token.mutation = mutationRecord(token.payload, claimMutations, (claims) => signFlaskToken(claims, flask.timestampPart || base64UrlNoPad(integerToBytes(Math.floor(Date.now() / 1000))), asString(flask.matches[0]?.secret) || "", flask.matches[0] || {}, flask.decoded.compressed));
		result.kind = "flask";
		result.sessionToken = token;
		result.token = token;
		return result;
	}

	const rails = await verifyRailsToken(sample.value, secrets);
	if (rails) {
		const token: Record<string, unknown> = {
			format: "rails",
			payload: rails.decoded.json ?? rails.decoded.text,
			encoding: rails.decoded.encoding,
			urlEncoded: rails.decoded.urlEncoded,
			signature: { present: true, algorithmSupported: true, testedSecretCandidateCount: rails.testedSecretCandidateCount, verified: rails.matches.length > 0, matches: rails.matches },
		};
		token.mutation = mutationRecord(token.payload, claimMutations, (claims) => signRailsToken(claims, asString(rails.matches[0]?.secret) || "", rails.matches[0] || {}, asString(rails.decoded.encoding) || "raw", Boolean(rails.decoded.urlEncoded)));
		result.kind = "rails";
		result.sessionToken = token;
		result.token = token;
		return result;
	}

	const decodings: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const add = (encoding: string, text: string) => {
		const key = `${encoding}:${text}`;
		if (seen.has(key)) return;
		seen.add(key);
		decodings.push({ encoding, text: text.slice(0, 2_000), json: tryJson(text) ?? undefined });
	};
	const rawJson = tryJson(sample.value);
	if (rawJson !== undefined) decodings.push({ encoding: "raw", text: sample.value.slice(0, 2_000), json: rawJson });
	try {
		const decoded = decodeURIComponent(sample.value);
		if (decoded !== sample.value) add("url", decoded);
	} catch {}
	if (/^[A-Za-z0-9+/_=-]{8,}$/.test(sample.value)) {
		for (const encoding of ["base64url", "base64"] as const) {
			const buffer = encoding === "base64url" ? base64UrlDecode(sample.value) : Buffer.from(sample.value, "base64");
			const text = buffer ? printableText(buffer) : undefined;
			if (text) add(encoding, text);
		}
	}
	result.kind = decodings.some((item) => item.json !== undefined) ? "encoded-json" : "opaque";
	result.decodings = decodings;
	return result;
}

export function tokenCountOf(result: Record<string, unknown>): number {
	return isRecord(result.token) || isRecord(result.jwt) ? 1 : 0;
}

export function tokenVerifiedOf(result: Record<string, unknown>): boolean {
	const token = isRecord(result.token) ? result.token : isRecord(result.jwt) ? result.jwt : undefined;
	return isRecord(token) ? tokenVerified(token) : false;
}

export function tokenMutationToken(result: Record<string, unknown>): string | undefined {
	const token = isRecord(result.token) ? result.token : isRecord(result.jwt) ? result.jwt : undefined;
	if (!isRecord(token) || !isRecord(token.mutation)) return undefined;
	return asString(token.mutation.token);
}

export function tokenPayloadOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
	const token = isRecord(result.token) ? result.token : isRecord(result.jwt) ? result.jwt : undefined;
	return tokenPayload(token);
}

export function tokenFormatOf(result: Record<string, unknown>): string | undefined {
	const token = isRecord(result.token) ? result.token : isRecord(result.jwt) ? result.jwt : undefined;
	return isRecord(token) ? asString(token.format) || asString(token.alg) : undefined;
}
