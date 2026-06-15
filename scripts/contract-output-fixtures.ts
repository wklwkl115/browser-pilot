import { buildEvidenceEnvelope } from "../src/kernels/evidence/index.js";
import { mintRef } from "../src/kernels/refs/index.js";

const actionRef = mintRef("dom", "example-button");
const networkRef = mintRef("network", "example-request");

const snapshots = {
	"contracts/output/observe.scan.snapshot.json": {
		kind: "observe.scan",
		envelope: {
			ok: true,
			data: {
				mode: "scan",
				url: "https://example.test/",
				actionables: [{ ref: actionRef, role: "button", text: "Continue" }],
			},
			evidence: buildEvidenceEnvelope({
				summary: { mode: "scan", actionableCount: 1 },
				runtimeRefs: [actionRef],
			}),
		},
	},
	"contracts/output/execute.result.snapshot.json": {
		kind: "execute.result",
		envelope: {
			ok: true,
			data: { value: 42 },
			evidence: buildEvidenceEnvelope({
				summary: { resultPath: "data.value", valueType: "number" },
			}),
		},
	},
	"contracts/output/network.summary.snapshot.json": {
		kind: "network.summary",
		envelope: {
			ok: true,
			data: { requests: 1, failures: 0 },
			evidence: buildEvidenceEnvelope({
				summary: { requests: 1, failures: 0 },
				runtimeRefs: [networkRef],
			}),
		},
	},
};

console.log(JSON.stringify(snapshots, null, 2));
