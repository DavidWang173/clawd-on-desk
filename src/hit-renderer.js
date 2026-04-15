// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
  window.hitAPI.onThemeConfig((cfg) => {
    tc = cfg || {};
    _reactions = (tc && tc.reactions) || {};
  });
}

// --- State synced from main ---
let currentSvg = null;
let currentState = null;
let miniMode = false;
let dndEnabled = false;

window.hitAPI.onStateSync((data) => {
  if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let lastScreenX, lastScreenY;
let mouseDownX, mouseDownY;
let pendingDx = 0, pendingDy = 0;
let dragRAF = null;
const DRAG_THRESHOLD = 3;

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  resetClickSequence();
  isReacting = false;
  isDragReacting = false;
});

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    area.setPointerCapture(e.pointerId);
    isDragging = true;
    didDrag = false;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    pendingDx = 0;
    pendingDy = 0;
    window.hitAPI.dragLock(true);
    area.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    pendingDx += e.screenX - lastScreenX;
    pendingDy += e.screenY - lastScreenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction();
      }
    }

    if (!dragRAF) {
      dragRAF = setTimeout(() => {
        window.hitAPI.moveWindowBy(pendingDx, pendingDy);
        pendingDx = 0;
        pendingDy = 0;
        dragRAF = null;
      }, 0);
    }
  }
});

function stopDrag() {
  if (!isDragging) return;
  isDragging = false;
  window.hitAPI.dragLock(false);
  area.classList.remove("dragging");
  if (pendingDx !== 0 || pendingDy !== 0) {
    if (dragRAF) { clearTimeout(dragRAF); dragRAF = null; }
    window.hitAPI.moveWindowBy(pendingDx, pendingDy);
    pendingDx = 0; pendingDy = 0;
  }
  if (didDrag) {
    window.hitAPI.dragEnd();
  }
  endDragReaction();
}

document.addEventListener("pointerup", (e) => {
  if (e.button === 0) {
    const wasDrag = didDrag;
    stopDrag();
    if (!wasDrag) {
      if (e.ctrlKey || e.metaKey) {
        window.hitAPI.showSessionMenu();
      } else {
        handleClick(e.clientX);
      }
    }
  }
});

area.addEventListener("pointercancel", () => stopDrag());
area.addEventListener("lostpointercapture", () => { if (isDragging) stopDrag(); });
window.addEventListener("blur", stopDrag);

// --- Click reaction logic (2-click = poke, 3-click = easter egg, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;

function _getReaction(name) {
  return _reactions[name] || null;
}

function resetClickSequence() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  clickCount = 0;
  firstClickDir = null;
}

function finishClickSequence() {
  clickTimer = null;
  const count = clickCount;
  const direction = firstClickDir;
  clickCount = 0;
  firstClickDir = null;

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (count >= 4 && doubleReact) {
    const files = doubleReact.files || [doubleReact.file];
    const file = files[Math.floor(Math.random() * files.length)];
    playReaction(file, doubleReact.duration || 3500);
    return;
  }

  if (count === 3) {
    window.hitAPI.triggerTripleClickAction();
    return;
  }

  if (count === 2) {
    if (annoyedReact && Math.random() < 0.5) {
      playReaction(annoyedReact.file, annoyedReact.duration || 3500);
    } else if (leftReact && rightReact) {
      const react = direction === "left" ? leftReact : rightReact;
      playReaction(react.file, react.duration || 2500);
    }
  }
}

function handleClick(clientX) {
  if (miniMode) {
    window.hitAPI.exitMiniMode();
    return;
  }
  if (isReacting || isDragReacting) return;

  // Non-idle: focus terminal, no reaction
  if (currentState !== "idle") {
    window.hitAPI.focusTerminal();
    return;
  }

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
    window.hitAPI.focusTerminal();
  }

  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(finishClickSequence, CLICK_WINDOW_MS);
}

function playReaction(svg, duration) {
  if (!svg) return;
  isReacting = true;
  window.hitAPI.playClickReaction(svg, duration);
  // Local timer to ungate input after duration
  setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return;

  if (isReacting) {
    isReacting = false;
  }

  isDragReacting = true;
  window.hitAPI.startDragReaction();
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.hitAPI.endDragReaction();
}

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.hitAPI.showContextMenu();
});
