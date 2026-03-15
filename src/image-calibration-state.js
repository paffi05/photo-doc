import { buildCalibrationMetadata } from "./image-calibration-geometry";

export function createCalibrationState() {
  return {
    metadata: buildCalibrationMetadata(),
    debugVisible: true,
    manualMode: false,
    manualStep: 0,
    manualPoints: [],
    lastError: "",
    requestId: 0,
  };
}

export function resetCalibrationState(state) {
  state.metadata = buildCalibrationMetadata();
  state.manualMode = false;
  state.manualStep = 0;
  state.manualPoints = [];
  state.lastError = "";
}

export function setCalibrationProcessing(state, isProcessing) {
  state.metadata = {
    ...state.metadata,
    isProcessing: Boolean(isProcessing),
    calibrationStatus: isProcessing ? "processing" : state.metadata.calibrationStatus,
  };
}
