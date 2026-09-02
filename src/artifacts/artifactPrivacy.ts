export const BROWSER_ARTIFACT_ROOT = ".browser-pilot/artifacts";
export const BROWSER_ARTIFACT_CLEANUP_HINT = "Delete stale local evidence with: rm -rf .browser-pilot/artifacts/*";

/**
 * Artifacts are raw local evidence: observations, screenshots, and network captures are written
 * exactly as the browser reported them, without content redaction. They stay under the project
 * root and are the operator's responsibility to retain or delete.
 */
export function browserArtifactPrivacyMetadata() {
	return {
		classification: "local_raw_evidence",
		root: BROWSER_ARTIFACT_ROOT,
		localOnly: true,
		retention: "manual_cleanup",
		cleanup: BROWSER_ARTIFACT_CLEANUP_HINT,
		contentRedaction: "none",
	};
}
