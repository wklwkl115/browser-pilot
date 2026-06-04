// Public surface of the ABML pure-core kernel — "@pi/abml-core in waiting".
//
// Zero browser / zero Node dependencies. Importing this barrel = seeing everything the kernel
// exposes in one place; it is also the future workspace package's entry point. The boundary is
// enforced by the check:abml-core-boundary contract. See docs/abml-kernel-manifest.md.
//
// Existing consumers still import the individual modules via the src/abml/ re-export shims; this
// barrel is additive and changes nothing for them.
export * from "./types.js";
export * from "./refPolicy.js";
export * from "./actionabilityModel.js";
export * from "./resolveModel.js";
export * from "./entity.js";
export * from "./ax.js";
export * from "./relations.js";
export * from "./inference.js";
export * from "./diff.js";
export * from "./stream.js";
export * from "./causal.js";
export * from "./templating.js";
export * from "./errors.js";
export * from "./verbs/router.js";
export * from "./verbs/click.js";
export * from "./verbs/type.js";
export * from "./verbs/scroll.js";
export * from "./verbs/read.js";
export * from "./verbs/frame.js";
export * from "./verbs/pierce.js";
