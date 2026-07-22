export type BackendNodeIdentity = {
	backendNodeId: number;
	targetId?: string;
};

export function cleanTargetId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

export function backendNodeKey(identity: BackendNodeIdentity): string {
	return identity.targetId ? `t:${identity.targetId}:b:${identity.backendNodeId}` : bareBackendNodeKey(identity.backendNodeId);
}

export function bareBackendNodeKey(backendNodeId: number): string {
	return `b:${backendNodeId}`;
}
