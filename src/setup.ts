// `claude-sessions setup [--apply]`: the settings.json + MCP registration for this machine, so nobody has to work it out.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_DIR, RETENTION_DAYS } from "./store.js";

const TOOLS = ["mcp__claude-sessions__search_sessions", "mcp__claude-sessions__read_session"];
const q = (s: string) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s);
const isOurHook = (e: any) =>
  e?.hooks?.some((h: any) => /claude-sessions/.test(h?.command ?? "") && /\sindex$/.test(h?.command ?? ""));

/**
 * Prints the changes, or with apply makes them (settings.json is backed up first). Uses absolute paths to node and
 * the built scripts, because hooks and MCP servers don't always inherit a PATH with node on it (nvm, desktop app).
 */
export function setup(apply: boolean) {
  const dist = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
  const node = process.execPath;
  const hook = `${q(node)} ${q(path.join(dist, "cli.js"))} index`;
  const mcp = ["mcp", "add", "--scope", "user", "claude-sessions", "--", node, path.join(dist, "server.js")];
  const file = path.join(CLAUDE_DIR, "settings.json");
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const changes: string[] = [];

  if ((s.cleanupPeriodDays ?? 30) < RETENTION_DAYS) {
    changes.push(`cleanupPeriodDays: ${s.cleanupPeriodDays ?? "30 (default)"} -> ${RETENTION_DAYS}`);
    s.cleanupPeriodDays = RETENTION_DAYS;
  }
  s.hooks ??= {};
  const ends: any[] = s.hooks.SessionEnd ?? [];
  if (!ends.some((e) => e?.hooks?.some((h: any) => h?.command === hook))) {
    s.hooks.SessionEnd = [...ends.filter((e) => !isOurHook(e)), { hooks: [{ type: "command", command: hook }] }];
    changes.push(`hooks.SessionEnd: ${ends.some(isOurHook) ? "replace" : "add"} ${hook}`);
  }
  s.permissions ??= {};
  s.permissions.allow ??= [];
  for (const t of TOOLS) {
    if (!s.permissions.allow.includes(t)) { s.permissions.allow.push(t); changes.push(`permissions.allow: add ${t}`); }
  }

  console.log(`${file}:`);
  console.log(changes.length ? changes.map((c) => `  ${c}`).join("\n") : "  already up to date");
  console.log(`MCP server (user scope):\n  claude ${mcp.map(q).join(" ")}`);
  if (!apply) {
    console.log("\nNothing changed yet. Run `claude-sessions setup --apply` to make these changes.");
    return;
  }
  if (changes.length) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak-claude-sessions`);
      console.log(`\nBacked up settings to ${file}.bak-claude-sessions`);
    }
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  }
  spawnSync("claude", ["mcp", "remove", "--scope", "user", "claude-sessions"], { stdio: "ignore" });
  const r = spawnSync("claude", mcp, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("`claude mcp add` failed; run the MCP command above yourself.");
    process.exitCode = 1;
  }
}
