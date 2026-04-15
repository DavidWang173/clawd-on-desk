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
let resolvedState = null;
let miniMode = false;
let dndEnabled = false;
let transientSource = null;

window.hitAPI.onStateSync((data) => {
  if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.resolvedState !== undefined) resolvedState = data.resolvedState;
  if (data.transientSource !== undefined) transientSource = data.transientSource;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
  if (currentState !== "idle" || miniMode || dndEnabled) {
    cancelHoverTracking();
  }
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let lastScreenX, lastScreenY;
let mouseDownX, mouseDownY;
let pendingDx = 0, pendingDy = 0;
let dragRAF = null;
const DRAG_THRESHOLD = 3;
const LONG_PRESS_MIN_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD = 6;
const DRAG_RELEASE_MIN_DISTANCE = 12;
const DRAG_RELEASE_MAX_DISTANCE = 84;
const HOVER_MIN_MS = 1200;
const HOVER_MAX_MS = 1800;

let pointerDownAt = 0;
let maxPressTravel = 0;
let dragReleaseDistance = 0;
let hoverTimer = null;
let hoverInside = false;
let hoverTriggeredForEntry = false;

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  resetClickSequence();
  isReacting = false;
  isDragReacting = false;
});

function randomInRange(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function resetPointerTracking() {
  pointerDownAt = 0;
  maxPressTravel = 0;
  dragReleaseDistance = 0;
}

function cancelHoverTracking(resetEntry = false) {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (resetEntry) hoverTriggeredForEntry = false;
}

function canTriggerGestureLocally() {
  return !miniMode
    && !dndEnabled
    && resolvedState === "idle"
    && (currentState === "idle" || transientSource === "ambient")
    && !isReacting
    && !isDragReacting;
}

function triggerGesture(type) {
  if (!type || !canTriggerGestureLocally()) return;
  window.hitAPI.triggerGesture(type);
}

function scheduleHoverTracking() {
  cancelHoverTracking();
  if (!hoverInside || hoverTriggeredForEntry || isDragging || !canTriggerGestureLocally()) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (!hoverInside || hoverTriggeredForEntry || isDragging || !canTriggerGestureLocally()) return;
    hoverTriggeredForEntry = true;
    triggerGesture("hover");
  }, randomInRange(HOVER_MIN_MS, HOVER_MAX_MS));
}

function shouldTriggerLongPress() {
  if (!canTriggerGestureLocally()) return false;
  if (didDrag || pointerDownAt === 0) return false;
  if (maxPressTravel > LONG_PRESS_MOVE_THRESHOLD) return false;
  return (Date.now() - pointerDownAt) >= LONG_PRESS_MIN_MS;
}

function shouldTriggerDragRelease() {
  if (miniMode || dndEnabled) return false;
  if (resolvedState !== "idle") return false;
  if (currentState !== "idle" && transientSource !== "ambient") return false;
  if (isReacting) return false;
  return dragReleaseDistance >= DRAG_RELEASE_MIN_DISTANCE
    && dragReleaseDistance <= DRAG_RELEASE_MAX_DISTANCE;
}

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; resetPointerTracking(); return; }
    cancelHoverTracking();
    area.setPointerCapture(e.pointerId);
    isDragging = true;
    didDrag = false;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    pendingDx = 0;
    pendingDy = 0;
    pointerDownAt = Date.now();
    maxPressTravel = 0;
    dragReleaseDistance = 0;
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

    const totalDx = e.clientX - mouseDownX;
    const totalDy = e.clientY - mouseDownY;
    const totalDistance = Math.hypot(totalDx, totalDy);
    maxPressTravel = Math.max(maxPressTravel, totalDistance);
    dragReleaseDistance = Math.max(dragReleaseDistance, totalDistance);

    if (!didDrag) {
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
    const longPress = shouldTriggerLongPress();
    const dragRelease = didDrag && shouldTriggerDragRelease();
    const wasDrag = didDrag;
    stopDrag();
    if (longPress) {
      resetClickSequence();
      triggerGesture("longpress");
      resetPointerTracking();
      return;
    }
    if (dragRelease) {
      triggerGesture("drag-release");
      resetPointerTracking();
      return;
    }
    if (!wasDrag) {
      if (e.ctrlKey || e.metaKey) {
        window.hitAPI.showSessionMenu();
      } else {
        handleClick(e.clientX);
      }
    }
    resetPointerTracking();
  }
});

area.addEventListener("pointerenter", () => {
  hoverInside = true;
  hoverTriggeredForEntry = false;
  scheduleHoverTracking();
});

area.addEventListener("pointerleave", () => {
  hoverInside = false;
  cancelHoverTracking(true);
});

area.addEventListener("pointercancel", () => {
  stopDrag();
  resetPointerTracking();
  cancelHoverTracking();
});
area.addEventListener("lostpointercapture", () => {
  if (isDragging) stopDrag();
  resetPointerTracking();
});
window.addEventListener("blur", () => {
  stopDrag();
  resetPointerTracking();
  cancelHoverTracking();
});

// --- Click reaction logic (2-click = poke, 4-click = flail) ---
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

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (clickCount >= 4 && doubleReact) {
    resetClickSequence();
    const files = doubleReact.files || [doubleReact.file];
    const file = files[Math.floor(Math.random() * files.length)];
    playReaction(file, doubleReact.duration || 3500);
  } else if (clickCount >= 2) {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      if (annoyedReact && Math.random() < 0.5) {
        firstClickDir = null;
        playReaction(annoyedReact.file, annoyedReact.duration || 3500);
      } else if (leftReact && rightReact) {
        const react = firstClickDir === "left" ? leftReact : rightReact;
        firstClickDir = null;
        playReaction(react.file, react.duration || 2500);
      } else {
        firstClickDir = null;
      }
    }, CLICK_WINDOW_MS);
  } else {
    clickTimer = setTimeout(() => {
      resetClickSequence();
    }, CLICK_WINDOW_MS);
  }
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
