// Re-export shim — this pure-core verb moved to src/abml-core/verbs/ (see docs/abml-kernel-manifest.md).
// Importers keep using "../abml/verbs/frame.js"; the kernel lives in abml-core. Boundary: check:abml-core-boundary.
export * from "../../abml-core/verbs/frame.js";
