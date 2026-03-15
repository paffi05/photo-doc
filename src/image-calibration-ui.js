export function getAiButtonMarkup() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3L13.9 8.1L19 10L13.9 11.9L12 17L10.1 11.9L5 10L10.1 8.1L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M19 15L19.8 17.2L22 18L19.8 18.8L19 21L18.2 18.8L16 18L18.2 17.2L19 15Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M6 14L6.7 15.8L8.5 16.5L6.7 17.2L6 19L5.3 17.2L3.5 16.5L5.3 15.8L6 14Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

export function getCalibrationStatusText(state) {
  if (state.metadata.isProcessing) return "Aligning markers...";
  if (state.manualMode) {
    return state.manualStep < 1 ? "Click the left marker center." : "Click the right marker center.";
  }
  if (state.metadata.calibrationStatus === "success") return "AI calibration applied.";
  if (state.metadata.calibrationStatus === "failed") return state.lastError || "Marker detection failed.";
  return "";
}
