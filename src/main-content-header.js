export function createMainHeaderTimeline(mainCanvas) {
  const header = document.createElement("div");
  header.className = "main-content-header";

  const timeline = document.createElement("div");
  timeline.className = "main-timeline";
  timeline.hidden = true;
  timeline.innerHTML = `
    <div class="main-timeline-prefix-line" hidden></div>
    <div class="main-timeline-scroll">
      <div class="main-timeline-track">
        <div class="main-timeline-line"></div>
      </div>
    </div>
  `;
  mainCanvas.appendChild(timeline);

  const patientLabel = document.createElement("div");
  patientLabel.className = "main-selected-patient";
  patientLabel.hidden = true;

  const patientNameRow = document.createElement("div");
  patientNameRow.className = "main-selected-name-row";
  patientLabel.appendChild(patientNameRow);

  const patientLast = document.createElement("span");
  patientLast.className = "main-selected-last";
  patientNameRow.appendChild(patientLast);

  const patientFirst = document.createElement("span");
  patientFirst.className = "main-selected-first";
  patientNameRow.appendChild(patientFirst);

  const patientIdLine = document.createElement("div");
  patientIdLine.className = "main-selected-id";
  patientLabel.appendChild(patientIdLine);

  const patientIdInput = document.createElement("input");
  patientIdInput.className = "main-selected-id-input";
  patientIdInput.type = "text";
  patientIdInput.inputMode = "numeric";
  patientIdInput.placeholder = "Add ID...";
  patientIdInput.hidden = true;
  patientLabel.appendChild(patientIdInput);

  header.appendChild(patientLabel);
  mainCanvas.appendChild(header);

  return {
    header,
    timeline,
    patientLabel,
    patientNameRow,
    patientLast,
    patientFirst,
    patientIdLine,
    patientIdInput,
    timelineScroll: timeline.querySelector(".main-timeline-scroll"),
    timelinePrefixLine: timeline.querySelector(".main-timeline-prefix-line"),
    timelineTrack: timeline.querySelector(".main-timeline-track"),
    timelineLine: timeline.querySelector(".main-timeline-line"),
  };
}
