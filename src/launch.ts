import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Session } from "./store.js";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

function detached(cmd: string, args: string[]) {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

export type LaunchMode = "auto" | "tmux" | "terminal" | "print";

/** Opens `claude --resume <id>` in the session's original directory. Returns a human-readable result. */
export function launch(s: Session, mode: LaunchMode = "auto"): string {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  const resume = `${bin} --resume ${s.id}`;
  const cwd = s.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return `The session's original directory (${cwd ?? "unknown"}) no longer exists, so it can't be resumed there. ` +
      `Recreate or re-clone it at that path, then run: cd ${q(cwd ?? "<dir>")} && ${resume}`;
  }
  const shellCmd = `cd ${q(cwd)} && ${resume}`;

  if (mode === "print") return `Run: ${shellCmd}`;

  if ((mode === "auto" || mode === "tmux") && process.env.TMUX) {
    const r = spawnSync("tmux", ["new-window", "-c", cwd, "-n", `cc-${s.id.slice(0, 8)}`, resume]);
    if (r.status === 0) return `Opened in a new tmux window (cc-${s.id.slice(0, 8)}).`;
  }
  if (mode === "tmux") return `tmux isn't available here. Run: ${shellCmd}`;

  if (process.platform === "darwin" && process.env.TERM_PROGRAM === "iTerm.app") {
    // Split the pane this Claude Code runs in (ITERM_SESSION_ID is "w0t1p0:<uuid>"), so no new window to hunt for.
    // Falls back to the focused pane if that id can't be found.
    const uuid = process.env.ITERM_SESSION_ID?.split(":")[1] ?? "";
    const script = `tell application "iTerm"
 activate
 set target to missing value
 repeat with w in windows
  repeat with t in tabs of w
   repeat with p in sessions of t
    if unique id of p is ${JSON.stringify(uuid)} then set target to p
   end repeat
  end repeat
 end repeat
 if target is missing value then set target to current session of current window
 tell target
  set pane to (split vertically with default profile)
 end tell
 tell pane
  select
  write text ${JSON.stringify(shellCmd)}
 end tell
end tell`;
    const r = spawnSync("osascript", ["-e", script]);
    if (r.status === 0) return "Opened in a new iTerm split pane beside this one.";
  }
  if (process.platform === "darwin") {
    const script = `tell application "Terminal"\n do script ${JSON.stringify(shellCmd)}\n activate\nend tell`;
    const r = spawnSync("osascript", ["-e", script]);
    if (r.status === 0) return "Opened in a new Terminal window.";
  } else if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    const keep = `${shellCmd}; exec $SHELL`;
    if (has("gnome-terminal")) { detached("gnome-terminal", ["--", "bash", "-lc", keep]); return "Opened in a new GNOME Terminal window."; }
    if (has("konsole")) { detached("konsole", ["-e", "bash", "-lc", keep]); return "Opened in a new Konsole window."; }
    if (has("x-terminal-emulator")) { detached("x-terminal-emulator", ["-e", "bash", "-lc", keep]); return "Opened in a new terminal window."; }
  }
  return `Couldn't open a terminal automatically (no tmux or GUI terminal found). Run: ${shellCmd}`;
}
