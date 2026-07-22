import schema from "../bridge/protocol/native-command.schema.json" with { type: "json" };

export const nativeToolMetadata = schema.toolMetadata;
export const nativeCommandToolMetadata = nativeToolMetadata.nativeCommandTools;
export const nativeTransferToolMetadata = nativeToolMetadata.transferTools;
