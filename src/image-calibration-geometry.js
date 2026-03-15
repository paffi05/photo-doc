export const MARKER_DISTANCE_MM = 140.0;

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizePoint(point = null) {
  return {
    x: toNumber(point?.x),
    y: toNumber(point?.y),
  };
}

export function normalizeRect(rect = null) {
  return {
    x: toNumber(rect?.x),
    y: toNumber(rect?.y),
    width: toNumber(rect?.width),
    height: toNumber(rect?.height),
  };
}

export function computeMarkerCalibration(leftPoint, rightPoint, options = {}) {
  const left = normalizePoint(leftPoint);
  const right = normalizePoint(rightPoint);
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const markerDistancePx = Math.hypot(dx, dy);
  if (!(markerDistancePx > 0)) {
    throw new Error("Marker distance must be greater than zero.");
  }
  const angleRad = Math.atan2(dy, dx);
  const rotationAngleDeg = -(angleRad * 180) / Math.PI;
  const targetDistanceMm = toNumber(options.targetDistanceMm, MARKER_DISTANCE_MM);
  const pxPerMm = markerDistancePx / targetDistanceMm;
  const mmPerPx = targetDistanceMm / markerDistancePx;
  return {
    leftMarkerCenter: left,
    rightMarkerCenter: right,
    rotationAngleDeg,
    markerDistancePx,
    pxPerMm,
    mmPerPx,
    targetDistanceMm,
  };
}

export function buildCalibrationMetadata({
  leftMarkerCenter,
  rightMarkerCenter,
  rotationAngleDeg,
  markerDistancePx,
  pxPerMm,
  mmPerPx,
  calibrationStatus = "idle",
  detectionConfidence = 0,
  detectionConfidenceCutoff = 0.55,
  isProcessing = false,
  calibrationSource = null,
  faceBounds = null,
  faceDetectionSource = null,
} = {}) {
  return {
    leftMarkerCenter: normalizePoint(leftMarkerCenter),
    rightMarkerCenter: normalizePoint(rightMarkerCenter),
    rotationAngleDeg: toNumber(rotationAngleDeg),
    markerDistancePx: toNumber(markerDistancePx),
    pxPerMm: toNumber(pxPerMm),
    mmPerPx: toNumber(mmPerPx),
    calibrationStatus: String(calibrationStatus ?? "idle"),
    detectionConfidence: toNumber(detectionConfidence),
    detectionConfidenceCutoff: toNumber(detectionConfidenceCutoff, 0.55),
    isProcessing: Boolean(isProcessing),
    calibrationSource: calibrationSource ? String(calibrationSource) : null,
    faceBounds: normalizeRect(faceBounds),
    faceDetectionSource: faceDetectionSource ? String(faceDetectionSource) : null,
  };
}

export function formatCalibrationDebug(metadata = null) {
  if (!metadata) return [];
  return [
    `status: ${metadata.calibrationStatus ?? "idle"}`,
    `source: ${metadata.calibrationSource ?? "-"}`,
    `confidence: ${(toNumber(metadata.detectionConfidence) * 100).toFixed(1)}%`,
    `cutoff: ${(toNumber(metadata.detectionConfidenceCutoff, 0.55) * 100).toFixed(1)}%`,
    `angle: ${toNumber(metadata.rotationAngleDeg).toFixed(2)} deg`,
    `distance: ${toNumber(metadata.markerDistancePx).toFixed(2)} px`,
    `px/mm: ${toNumber(metadata.pxPerMm).toFixed(4)}`,
    `mm/px: ${toNumber(metadata.mmPerPx).toFixed(4)}`,
  ];
}
