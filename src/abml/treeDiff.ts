// Re-export shim — this pure-core module moved to src/abml-core/ (see docs/abml-kernel-manifest.md).
// Importers keep using "../abml/treeDiff.js"; the kernel lives in abml-core. Boundary: check:abml-core-boundary.
export * from "../abml-core/treeDiff.js";
