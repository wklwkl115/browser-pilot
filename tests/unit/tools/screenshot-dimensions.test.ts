// browser_screenshot now decodes pixel width/height from the captured image data URL so the summary
// reports dimensions without the agent reading the saved file out-of-band (blind-eval R7 minor).
import test from "node:test";
import assert from "node:assert/strict";
import { imageDimensions } from "../../../src/tools/registerScreenshotTool.ts";

// 1x1 transparent PNG.
const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYAAACVStBjAAAAAElFTkSuQmCC";

test("imageDimensions decodes PNG IHDR width/height", () => {
	assert.deepEqual(imageDimensions(PNG_1x1), { width: 1, height: 1 });
});

test("imageDimensions decodes JPEG SOF width/height", () => {
	// Minimal JPEG: SOI + APP0(JFIF) + SOF0 declaring 3x2, height before width (big-endian).
	const bytes = [
		0xff, 0xd8, // SOI
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
		0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0 h=2 w=3
	];
	const dataUrl = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
	assert.deepEqual(imageDimensions(dataUrl), { width: 3, height: 2 });
});

test("imageDimensions returns undefined for non-image / malformed input (no fabrication)", () => {
	assert.equal(imageDimensions("not-a-data-url"), undefined);
	assert.equal(imageDimensions("data:text/plain;base64,aGVsbG8="), undefined);
});
