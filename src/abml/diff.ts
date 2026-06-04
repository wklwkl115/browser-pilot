// Re-export shim — this pure-core diff module lives in src/abml-core/ (see docs/abml-kernel-manifest.md).
// Importers may use "../abml/diff.js" while the kernel stays in abml-core. Boundary: check:abml-core-boundary.
export * from "../abml-core/diff.js";
