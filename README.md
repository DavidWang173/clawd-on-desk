<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk</h1>
<p align="center">
  <a href="README.zh-CN.md">中文版</a>
</p>

A desktop pet that reacts to your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in real-time. Clawd lives on your screen — thinking when you prompt, typing when tools run, juggling subagents, celebrating when tasks complete, and sleeping when you're away.

> Windows 11 only. Requires Node.js and Claude Code.

## Features

- **Real-time state awareness** — Claude Code hooks drive Clawd's animations automatically
- **12 animated states** — idle, thinking, typing, building, juggling, conducting, error, happy, notification, sweeping, carrying, sleeping
- **Eye tracking** — Clawd follows your cursor in idle state, with body lean and shadow stretch
- **Sleep sequence** — yawning, dozing, collapsing, sleeping after 60s idle; mouse movement wakes Clawd
- **Click reactions** — double-click for a poke, 4 clicks for a flail
- **Drag from any state** — grab Clawd anytime, release to resume the current animation
- **Multi-session tracking** — multiple Claude Code sessions resolve to the highest-priority state
- **Subagent awareness** — juggling for 1 subagent, conducting for 2+
- **Position memory** — Clawd remembers where you left it across restarts
- **Single instance lock** — prevents duplicate Clawd windows
- **System tray** — resize (S/M/L), do-not-disturb mode, auto-start toggle

## State Mapping

| Claude Code Event | Clawd State | Animation | |
|---|---|---|---|
| Idle (no activity) | idle | Eye-tracking follow | <img src="assets/gif/clawd-idle.gif" width="48"> |
| UserPromptSubmit | thinking | Thought bubble | <img src="assets/gif/clawd-thinking.gif" width="48"> |
| PreToolUse / PostToolUse | working (typing) | Typing | <img src="assets/gif/clawd-typing.gif" width="48"> |
| PreToolUse (3+ sessions) | working (building) | Building | <img src="assets/gif/clawd-building.gif" width="48"> |
| SubagentStart (1) | juggling | Juggling | <img src="assets/gif/clawd-juggling.gif" width="48"> |
| SubagentStart (2+) | conducting | Conducting | <img src="assets/gif/clawd-conducting.gif" width="48"> |
| PostToolUseFailure | error | ERROR + smoke | <img src="assets/gif/clawd-error.gif" width="48"> |
| Stop / PostCompact | attention | Happy bounce | <img src="assets/gif/clawd-happy.gif" width="48"> |
| PermissionRequest / Notification | notification | Alert jump | <img src="assets/gif/clawd-notification.gif" width="48"> |
| PreCompact | sweeping | Broom sweep | <img src="assets/gif/clawd-sweeping.gif" width="48"> |
| WorktreeCreate | carrying | Carrying box | <img src="assets/gif/clawd-carrying.gif" width="48"> |
| 60s no events | sleeping | Sleep sequence | <img src="assets/gif/clawd-sleeping.gif" width="48"> |

## Quick Start

```bash
# Clone the repo
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Install dependencies
npm install

# Register Claude Code hooks
node hooks/install.js

# Start Clawd
npm start
```

## How It Works

```
Claude Code triggers hook event
  → hooks/clawd-hook.js (reads event + session_id from stdin)
  → HTTP POST to 127.0.0.1:23333
  → State machine in main.js (multi-session tracking + priority + min display time)
  → IPC to renderer.js (SVG preload + crossfade swap)
```

Clawd runs as a transparent, always-on-top, unfocusable Electron window. It never steals focus or blocks your workflow.

## Manual Testing

```bash
# Trigger a specific state
curl -X POST http://127.0.0.1:23333/state \
  -H "Content-Type: application/json" \
  -d '{"state":"working","session_id":"test"}'

# Cycle through all animations (8s each)
bash test-demo.sh
```

## Project Structure

```
src/
  main.js        # Electron main process: state machine, HTTP server, window, tray
  renderer.js    # Renderer: drag, click, SVG switching, eye tracking
  preload.js     # IPC bridge (contextBridge)
  index.html     # Page structure
hooks/
  clawd-hook.js  # Claude Code hook script (zero deps, 1s timeout)
  install.js     # Safe hook registration into ~/.claude/settings.json
assets/
  svg/           # 29 pixel-art SVG animations with CSS keyframes
  gif/           # Recorded GIFs for documentation
```

## Acknowledgments

- Clawd pixel art reference from [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- The Clawd character is the property of [Anthropic](https://www.anthropic.com). This is a community project, not officially affiliated with or endorsed by Anthropic.

## License

MIT
