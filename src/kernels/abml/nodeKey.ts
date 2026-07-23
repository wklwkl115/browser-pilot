export type BackendNodeIdentity = {
	backendNodeId: number;
	targetId?: string;
};

export { nonEmptyString as cleanTargetId } from "../../utils/records.js";

export function backendNodeKey(identity: BackendNodeIdentity): string {
	return identity.targetId ? `t:${identity.targetId}:b:${identity.backendNodeId}` : bareBackendNodeKey(identity.backendNodeId);
}

export function bareBackendNodeKey(backendNodeId: number): string {
	return `b:${backendNodeId}`;
}
