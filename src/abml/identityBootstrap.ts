// Re-export shim — this pure-core module lives in src/abml-core/ (see docs/abml-kernel-manifest.md).
// Importers keep using "../abml/identityBootstrap.js"; the kernel boundary is enforced by check:abml-core-boundary.
export * from "../abml-core/identityBootstrap.js";
