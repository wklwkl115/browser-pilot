// Re-export shim — this pure-core causal module lives in src/abml-core/ (see docs/abml-kernel-manifest.md).
// Importers may use "../abml/causal.js" while the kernel stays in abml-core. Boundary: check:abml-core-boundary.
export * from "../abml-core/causal.js";
