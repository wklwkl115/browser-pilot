export const BROWSER_ARTIFACT_ROOT = ".pi/browser-artifacts";
export const BROWSER_ARTIFACT_CLEANUP_HINT = "Delete stale local evidence with: rm -rf .pi/browser-artifacts/*";

export { containsSensitiveEvidence, redactSensitiveText, redactSensitiveValue, redactSensitiveValueWithPointers } from "../utils/redaction.js";

export function browserArtifactPrivacyMetadata() {
	return {
		classification: "local_raw_evidence",
		root: BROWSER_ARTIFACT_ROOT,
		localOnly: true,
		retention: "manual_cleanup",
		cleanup: BROWSER_ARTIFACT_CLEANUP_HINT,
		summaryRedaction: "cookie/token/authorization/body/postData/websocket payload fields are redacted from summaries by default",
	};
}
