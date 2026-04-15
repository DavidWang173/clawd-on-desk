// src/tick.js — Main tick loop (cursor polling, eye tracking, idle/sleep detection, mini peek)
// Extracted from main.js L527-689

const { screen } = require("electron");

module.exports = function initTick(ctx) {

// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions
let idleWasActive = false;
let lastEyeDx = 0, lastEyeDy = 0;
let mainTickTimer = null;
let ambientNextAt = 0;
let ambientArmed = false;

const NORMAL_TICK_MS = 50;
const LOW_POWER_TICK_MS = 125;

// ── Theme-driven state (refreshed on hot theme switch) ──
let theme = null;
let MOUSE_IDLE_TIMEOUT = 0;
let MOUSE_SLEEP_TIMEOUT = 0;
let SVG_IDLE_FOLLOW = null;
let IDLE_ANIMS = [];

function refreshTheme() {
  theme = ctx.theme;
  MOUSE_IDLE_TIMEOUT = theme.timings.mouseIdleTimeout;
  MOUSE_SLEEP_TIMEOUT = theme.timings.mouseSleepTimeout;
  SVG_IDLE_FOLLOW = theme.states.idle[0];
  IDLE_ANIMS = (theme.idleAnimations || []).map(a => ({ svg: a.file, duration: a.duration }));
}

refreshTheme();

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function scheduleAmbient(initial = false) {
  ambientArmed = true;
  ambientNextAt = Date.now() + randInt(initial ? 45000 : 60000, initial ? 75000 : 120000);
}

function scheduleAmbientRetry() {
  ambientArmed = true;
  ambientNextAt = Date.now() + randInt(15000, 30000);
}

function clearAmbientSchedule() {
  ambientArmed = false;
  ambientNextAt = 0;
}

function noteAmbientActivity() {
  clearAmbientSchedule();
  if (ctx.currentState === "idle" && !ctx.idlePaused && !ctx.miniMode && !ctx.miniTransitioning) {
    scheduleAmbient(true);
  }
}

function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item.build();
  }
  return items[items.length - 1].build();
}

function pickAmbientAction() {
  const buildSvg = theme.workingTiers && theme.workingTiers[0] ? theme.workingTiers[0].file : null;
  const conductSvg = theme.jugglingTiers && theme.jugglingTiers[0] ? theme.jugglingTiers[0].file : null;
  const items = [
    { weight: 24, build: () => ({ state: "thinking", durationMs: randInt(2500, 4000), source: "ambient" }) },
    { weight: 22, build: () => ({ state: "working", durationMs: randInt(2000, 3500), source: "ambient" }) },
    { weight: 18, build: () => ({ state: "attention", durationMs: randInt(1500, 2500), source: "ambient" }) },
    { weight: 12, build: () => ({ state: "sweeping", durationMs: randInt(3000, 4500), source: "ambient" }) },
    { weight: 10, build: () => ({ state: "juggling", durationMs: randInt(3000, 5000), source: "ambient" }) },
    { weight: buildSvg ? 6 : 0, build: () => ({ state: "working", svgOverride: buildSvg, durationMs: randInt(4000, 6000), source: "ambient" }) },
    { weight: 5, build: () => ({ state: "carrying", durationMs: randInt(2000, 3000), source: "ambient" }) },
    { weight: conductSvg ? 2 : 0, build: () => ({ state: "juggling", svgOverride: conductSvg, durationMs: randInt(4000, 6000), source: "ambient" }) },
  ];
  return pickWeighted(items);
}

function getTickIntervalMs() {
  return ctx.lowPowerMode ? LOW_POWER_TICK_MS : NORMAL_TICK_MS;
}

function tickOnce() {
  if (!ctx.win || ctx.win.isDestroyed()) return;

  // ── Idle state edge detection (must run every tick for timer cleanup) ──
  const idleNow = ctx.currentState === "idle" && !ctx.idlePaused;
  const miniIdleNow = ctx.currentState === "mini-idle" && !ctx.idlePaused && !ctx.miniTransitioning;

  if (idleNow && !idleWasActive) {
    isMouseIdle = false;
    hasTriggeredYawn = false;
    idleLookPlayed = false;
    lastCursorX = null;
    lastCursorY = null;
    mouseStillSince = Date.now();
    lastEyeDx = 0;
    lastEyeDy = 0;
    if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
    if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    scheduleAmbient(true);
  }

  if (!idleNow && idleWasActive) {
    if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
    if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    clearAmbientSchedule();
  }
  idleWasActive = idleNow;

  // Skip expensive native IPC calls (getCursorScreenPoint, getBounds) when
  // cursor tracking is not needed — saves OS calls outside idle/mini flows.
  const needsCursorPoll = idleNow || miniIdleNow || ctx.miniMode;
  if (!needsCursorPoll) return;

  const cursor = screen.getCursorScreenPoint();

  // ── Cursor-over-pet tracking (for mini peek + eye tracking, NOT for input routing) ──
  const bounds = ctx.win.getBounds();
  if (!ctx.dragLocked) {
    const hit = ctx.getHitRectScreen(bounds);
    const over = cursor.x >= hit.left && cursor.x <= hit.right
              && cursor.y >= hit.top  && cursor.y <= hit.bottom;
    ctx.mouseOverPet = over;
  }

  // ── Mini mode peek hover ──
  if (ctx.miniMode && !ctx.miniTransitioning && !ctx.dragLocked && !ctx.menuOpen) {
    const canPeek = ctx.currentState === "mini-idle" || ctx.currentState === "mini-peek"
      || ctx.currentState === "mini-sleep";
    if (!ctx.isAnimating && canPeek) {
      if (ctx.mouseOverPet && ctx.currentState === "mini-sleep" && !ctx.miniSleepPeeked) {
        ctx.miniPeekIn();
        ctx.miniSleepPeeked = true;
      } else if (!ctx.mouseOverPet && ctx.currentState === "mini-sleep" && ctx.miniSleepPeeked) {
        ctx.miniPeekOut();
        ctx.miniSleepPeeked = false;
      } else if (ctx.mouseOverPet && ctx.currentState !== "mini-peek" && ctx.currentState !== "mini-sleep" && !ctx.miniPeeked) {
        ctx.miniPeekIn();
        ctx.applyState("mini-peek");
      } else if (!ctx.mouseOverPet && (ctx.currentState === "mini-peek" || ctx.miniPeeked)) {
        ctx.miniPeekOut();
        ctx.miniPeeked = false;
        if (ctx.currentState !== "mini-idle") ctx.applyState("mini-idle");
      }
    }
  }

  if (!idleNow && !miniIdleNow) return;

  const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
  lastCursorX = cursor.x;
  lastCursorY = cursor.y;

  // Normal idle: mouse idle detection + sleep sequence
  if (idleNow) {
    if (moved) {
      mouseStillSince = Date.now();
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
      if (isMouseIdle) {
        isMouseIdle = false;
        ctx.sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
      }
      scheduleAmbient(true);
    }

    const elapsed = Date.now() - mouseStillSince;

    // Startup recovery: Claude Code is running but no hook yet — stay awake
    // Only suppress sleep sequence, don't skip eye tracking below
    if (ctx.startupRecoveryActive) {
      mouseStillSince = Date.now();
    }

    // 60s no mouse movement → yawning → dozing
    if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
      hasTriggeredYawn = true;
      if (!isMouseIdle) ctx.sendToRenderer("eye-move", 0, 0);
      yawnDelayTimer = setTimeout(() => {
        yawnDelayTimer = null;
        if (ctx.currentState === "idle") ctx.setState("yawning");
      }, isMouseIdle ? 50 : 250);
      return;
    }

    // 20s no mouse movement → random idle animation (play once, then return to idle-follow)
    if (IDLE_ANIMS.length > 0 && !isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
      isMouseIdle = true;
      idleLookPlayed = true;
      const pick = IDLE_ANIMS[Math.floor(Math.random() * IDLE_ANIMS.length)];
      ctx.sendToRenderer("eye-move", 0, 0);
      setTimeout(() => {
        if (isMouseIdle && ctx.currentState === "idle") {
          ctx.sendToRenderer("state-change", "idle", pick.svg);
          ctx.sendToHitWin("hit-state-sync", { currentSvg: pick.svg });
        }
      }, 250);
      idleLookReturnTimer = setTimeout(() => {
        idleLookReturnTimer = null;
        if (isMouseIdle && ctx.currentState === "idle") {
          isMouseIdle = false;
          ctx.sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
          ctx.sendToHitWin("hit-state-sync", { currentSvg: SVG_IDLE_FOLLOW });
          setTimeout(() => { ctx.forceEyeResend = true; }, 200);
        }
      }, 250 + pick.duration);
      return;
    }

    const canAmbientTrigger = ambientArmed
      && Date.now() >= ambientNextAt
      && !isMouseIdle
      && !ctx.doNotDisturb
      && !ctx.miniMode
      && !ctx.miniTransitioning
      && !ctx.dragLocked
      && !ctx.menuOpen
      && !ctx.startupRecoveryActive
      && ctx.resolveDisplayState() === "idle"
      && typeof ctx.triggerTransientAction === "function";

    if (canAmbientTrigger) {
      const pick = pickAmbientAction();
      if (pick && ctx.triggerTransientAction(pick)) {
        scheduleAmbient(false);
        return;
      }
      scheduleAmbientRetry();
    }
  }

  const trackEyesNow = (idleNow && ctx.currentSvg === SVG_IDLE_FOLLOW && !isMouseIdle) || miniIdleNow;
  if (!trackEyesNow) return;
  if (ctx.eyePauseUntil) {
    if (Date.now() < ctx.eyePauseUntil) return;
    ctx.eyePauseUntil = null;
  }
  if (!moved && !ctx.forceEyeResend) return;

  const skipDedup = ctx.forceEyeResend;
  ctx.forceEyeResend = false;

  const obj = ctx.getObjRect(bounds);
  const eyeScreenX = obj.x + obj.w * theme.eyeTracking.eyeRatioX;
  const eyeScreenY = obj.y + obj.h * theme.eyeTracking.eyeRatioY;

  const relX = cursor.x - eyeScreenX;
  const relY = cursor.y - eyeScreenY;

  const MAX_OFFSET = theme.eyeTracking.maxOffset;
  const dist = Math.sqrt(relX * relX + relY * relY);
  let eyeDx = 0, eyeDy = 0;
  if (dist > 1) {
    const scale = Math.min(1, dist / 300);
    eyeDx = (relX / dist) * MAX_OFFSET * scale;
    eyeDy = (relY / dist) * MAX_OFFSET * scale;
  }

  eyeDx = Math.round(eyeDx * 2) / 2;
  eyeDy = Math.round(eyeDy * 2) / 2;
  const yClamp = MAX_OFFSET * 0.5;
  eyeDy = Math.max(-yClamp, Math.min(yClamp, eyeDy));

  if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
    lastEyeDx = eyeDx;
    lastEyeDy = eyeDy;
    ctx.sendToRenderer("eye-move", eyeDx, eyeDy);
  }
}

// ── Unified main tick (cursor polling for eye tracking + sleep + mini peek) ──
// Input routing is handled by hitWin — no setIgnoreMouseEvents toggling here.
function startMainTick() {
  if (mainTickTimer) return;
  // Render window: permanently click-through (set once, never toggle)
  ctx.win.setIgnoreMouseEvents(true);
  ctx.mouseOverPet = false;
  mainTickTimer = setInterval(tickOnce, getTickIntervalMs());
}

function setLowPowerMode() {
  if (!mainTickTimer) return;
  clearInterval(mainTickTimer);
  mainTickTimer = setInterval(tickOnce, getTickIntervalMs());
}

function resetIdleTimer() {
  mouseStillSince = Date.now();
}

function cleanup() {
  if (mainTickTimer) { clearInterval(mainTickTimer); mainTickTimer = null; }
  if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
  if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
  lastCursorX = null;
  lastCursorY = null;
  isMouseIdle = false;
  hasTriggeredYawn = false;
  idleLookPlayed = false;
  idleWasActive = false;
  lastEyeDx = 0;
  lastEyeDy = 0;
  clearAmbientSchedule();
}

// Expose mouseStillSince for wake poll (state.js deep sleep timeout)
Object.defineProperty(startMainTick, "_mouseStillSince", {
  get() { return mouseStillSince; },
});

return {
  startMainTick,
  resetIdleTimer,
  noteAmbientActivity,
  cleanup,
  refreshTheme,
  setLowPowerMode,
  get _mouseStillSince() { return mouseStillSince; },
};

};
