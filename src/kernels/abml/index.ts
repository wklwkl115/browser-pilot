// Public surface of the ABML pure-core kernel — "@browser-pilot/abml-kernel in waiting".
//
// Zero browser / zero Node dependencies. Importing this barrel = seeing everything the kernel
// exposes in one place; it is also the future workspace package's entry point. The boundary is
// enforced by the check:abml-kernel-boundary contract. See docs/abml-kernel-manifest.md.
//
// Consumers import this barrel or the individual kernel modules directly. Browser I/O belongs in
// src/adapters/browser-runtime/abml and must not be imported from this kernel.
export * from "./types.js";
export * from "./refId.js";
export * from "./refPolicy.js";
export * from "./actionabilityModel.js";
export * from "./entity.js";
export * from "./ax.js";
export * from "./relations.js";
export * from "./inference.js";
export * from "./diff.js";
export * from "./stream.js";
export * from "./causal.js";
export * from "./grouping.js";
export * from "./templating.js";
export * from "./treeDiff.js";
export * from "./semanticRefAnchor.js";
export * from "./snapshotProjection.js";
export * from "./collections.js";
export * from "./identityGraph.js";
export * from "./identityBootstrap.js";
export * from "./nodeKey.js";
export * from "./errors.js";
export * from "./verbs/router.js";
export * from "./verbs/read.js";
export * from "./verbs/frame.js";
export * from "./verbs/pierce.js";
