export const refLeakRules = [
	{
		key: "execute-stdlib-to-abml-types",
		description: "execute stdlib leaking ABML ref DTO aliases instead of resource-facing ref DTOs",
		fromPath: "src/browser-command-runtime/executeStdlib.ts",
		toPathPrefix: "src/kernels/abml/types.ts",
	},
	{
		key: "resource-ref-store-port-to-abml-types",
		description: "ResourceRefStorePort leaking ABML kernel DTO aliases instead of owning resource-facing ref DTOs",
		fromPath: "src/ports/ResourceRefStorePort.ts",
		toPathPrefix: "src/kernels/abml/types.ts",
	},
	{
		key: "browser-runtime-frame-to-abml-ref-types",
		description: "frame runtime leaking ABML RefDescriptor aliases instead of resource-facing ref DTOs",
		fromPath: "src/browser-runtime/abml/frameRuntime.ts",
		toPathPrefix: "src/kernels/abml/types.ts",
	},
	{
		key: "browser-runtime-pierce-to-abml-ref-types",
		description: "pierce runtime leaking ABML RefDescriptor aliases instead of resource-facing ref DTOs",
		fromPath: "src/browser-runtime/abml/pierceRuntime.ts",
		toPathPrefix: "src/kernels/abml/types.ts",
	},
	{
		key: "browser-runtime-vision-to-abml-ref-types",
		description: "vision runtime leaking ABML RefDescriptor aliases instead of resource-facing ref DTOs",
		fromPath: "src/browser-runtime/abml/visionRuntime.ts",
		toPathPrefix: "src/kernels/abml/types.ts",
	},
];
