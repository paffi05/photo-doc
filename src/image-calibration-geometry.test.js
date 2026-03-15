import test from "node:test";
import assert from "node:assert/strict";
import { buildCalibrationMetadata, computeMarkerCalibration } from "./image-calibration-geometry.js";

test("computeMarkerCalibration returns horizontal alignment rotation and scale", () => {
  const result = computeMarkerCalibration({ x: 100, y: 120 }, { x: 240, y: 160 });
  assert.equal(result.markerDistancePx, Math.hypot(140, 40));
  assert.ok(Math.abs(result.rotationAngleDeg + 15.945395900922854) < 1e-9);
  assert.ok(Math.abs(result.pxPerMm - (result.markerDistancePx / 140)) < 1e-12);
  assert.ok(Math.abs(result.mmPerPx - (140 / result.markerDistancePx)) < 1e-12);
});

test("buildCalibrationMetadata normalizes shape", () => {
  const metadata = buildCalibrationMetadata({
    leftMarkerCenter: { x: "10", y: "11" },
    calibrationStatus: "success",
    detectionConfidence: "0.87",
    calibrationSource: "auto",
  });
  assert.deepEqual(metadata.leftMarkerCenter, { x: 10, y: 11 });
  assert.deepEqual(metadata.rightMarkerCenter, { x: 0, y: 0 });
  assert.equal(metadata.calibrationStatus, "success");
  assert.equal(metadata.detectionConfidence, 0.87);
  assert.equal(metadata.calibrationSource, "auto");
});
