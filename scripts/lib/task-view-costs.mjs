import { readFile } from "node:fs/promises";
import { taskSnapshotEvidence } from "../../src/kernels/abml/taskViewSelection.ts";
import { packTaskView, taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import { readTaskProjectionResource } from "../../src/apps/mcp/taskViewResources.ts";
import {
	projectObservationOverflow,
	OBSERVATION_RESOURCES_DETAIL_KEY,
} from "../../src/commands/observe/observationResources.ts";
import { renderMcpToolResult } from "../../src/apps/mcp/server.ts";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** Deterministic replay of three delivery paths over one saved canonical observation and specification. */
export async function compareTaskViewCosts(result, projectRoot) {
	const descriptors = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] ?? [];
	const task = descriptors.find((descriptor) => descriptor.taskProjection);
	const canonical = descriptors.find((descriptor) => descriptor.jsonPath === "$");
	if (!task || !canonical) throw new Error("Task comparison requires a saved task and canonical snapshot");
	const saved = await readFile(task.path, "utf8");
	const artifact = JSON.parse(saved);
	const observation = JSON.parse(await readFile(canonical.path, "utf8"));
	const plan = artifact;
	const page = projectObservationOverflow(observation, canonical.path).observation;
	const group = packTaskView(observation, { ...plan, packets: [] }, task.uri, { items: [] });
	const packet = packTaskView(observation, plan, task.uri, { items: [] });
	const toolBytes = (view) =>
		bytes(
			renderMcpToolResult(
				"browser_observe",
				{
					...result,
					content: [{ type: "text", text: JSON.stringify(view) }],
				},
				projectRoot,
			),
		);
	const resourceBytes = (value, uri = task.uri) =>
		bytes({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] });
	const selected = plan.bundles.filter((bundle) => bundle.candidate);
	const wholeSaved = JSON.stringify({ ...artifact, packets: [] });
	const wholeDescriptor = { ...task, taskProjection: { sha256: taskArtifactHash(wholeSaved) } };
	const groupResourceBytes = (suffix) =>
		resourceBytes(readTaskProjectionResource(wholeSaved, wholeDescriptor, task.uri + suffix), task.uri + suffix);
	const packetResourceBytes = (suffix) =>
		resourceBytes(readTaskProjectionResource(saved, task, task.uri + suffix), task.uri + suffix);
	const groupReads = selected.filter((bundle) => !group.bundles.some((inline) => inline.id === bundle.id));
	const packetReads = (plan.packets ?? []).filter(
		(item) =>
			!packet.packets?.some((inline) => inline.id === item.id) &&
			!packet.bundles.some((inline) => inline.id === item.bundleId),
	);
	const groupIndexBytes = groupReads.length
		? Array.from(
				{ length: Math.floor(Math.max(...groupReads.map((item) => plan.bundles.indexOf(item))) / 16) + 1 },
				(_, i) => groupResourceBytes(i ? `/index/${i}` : ""),
			).reduce((a, b) => a + b, 0)
		: 0;
	const packetIndexBytes = packetReads.length
		? packetResourceBytes("") +
			Array.from(
				{ length: Math.floor(Math.max(...packetReads.map((item) => plan.packets.indexOf(item))) / 16) },
				(_, i) => packetResourceBytes(`/packet-index/${i + 1}`),
			).reduce((a, b) => a + b, 0)
		: 0;
	return {
		snapshotId: artifact.snapshotId,
		budgetBytes: 32768,
		unit: "serialized-mcp-json-utf8-bytes",
		method: "same-snapshot replay of full-page evidence, whole groups and packets; exact saved resource wrappers; no model inference",
		page: toolBytes(page) + resourceBytes(taskSnapshotEvidence(observation)),
		wholeGroup:
			toolBytes(group) +
			groupIndexBytes +
			groupReads.reduce((sum, item) => sum + groupResourceBytes(`/groups/${plan.bundles.indexOf(item)}`), 0),
		progressivePacket:
			toolBytes(packet) +
			packetIndexBytes +
			packetReads.reduce((sum, item) => sum + packetResourceBytes(`/packets/${plan.packets.indexOf(item)}`), 0),
	};
}
