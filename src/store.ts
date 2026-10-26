import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { embed, modelPath, modelPresent } from "./embed.js";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
export const HOME = process.env.CLAUDE_SESSIONS_HOME ?? path.join(os.homedir(), ".claude-sessions");
export const ARCHIVE_DIR = path.join(HOME, "archive");
/** Archived sessions untouched for longer than this are deleted from the archive and index. */
export const RETENTION_DAYS = Number(process.env.CLAUDE_SESSIONS_RETENTION_DAYS ?? 365);
const SCHEMA_VERSION = 3;

export type Session = {
  id: string;
  project_dir: string; // original folder name under ~/.claude/projects
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: string | null;
  updated_at: string | null;
  user_turns: number;
  archive_path: string;
  size: number;
  mtime_ms: number;
};

export function openDb(): Database.Database {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(HOME, "index.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000"); // the SessionEnd hook and the MCP server can sync at the same time
  // The index is derived from the archive, so a schema change just rebuilds it. Vectors (emb) are keyed by
  // text hash and only depend on the model, so they're kept.
  if ((db.pragma("user_version", { simple: true }) as number) < SCHEMA_VERSION) {
    db.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS chunks_tri;
      DROP TABLE IF EXISTS pieces;`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, cwd TEXT, git_branch TEXT,
      title TEXT, first_prompt TEXT, started_at TEXT, updated_at TEXT,
      user_turns INTEGER NOT NULL DEFAULT 0, archive_path TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      session_id UNINDEXED, role UNINDEXED, ts UNINDEXED, text,
      tokenize = 'porter unicode61');
    -- same rows (same rowid) as chunks, for substring matches like "netb" or "care_sub"
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(text, tokenize = 'trigram');
    -- passages for search by meaning; vectors are cached by text hash so re-indexing a grown session is cheap
    CREATE TABLE IF NOT EXISTS pieces(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      ts TEXT, text TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pieces_session ON pieces(session_id);
    CREATE INDEX IF NOT EXISTS pieces_hash ON pieces(hash);
    CREATE TABLE IF NOT EXISTS emb(hash TEXT PRIMARY KEY, vec BLOB NOT NULL);
  `);
  return db;
}

// ---------- transcript parsing ----------

/** tool = command/tool output, agent = subagent work. Both rank below the main conversation. */
export type Role = "user" | "assistant" | "tool" | "agent";
type Entry = { role: Role; ts: string | null; text: string; isPrompt: boolean };

const NOISE = [/^<command-/, /^<local-command-/, /^Caveat: /, /^\[Request interrupted/,
  /^<task-notification>/, /^<bash-stdout>/, /^<bash-stderr>/, /^<system-reminder>/];
const isNoise = (t: string) => NOISE.some((r) => r.test(t.trim()));

function toolBrief(name: string, input: any): string {
  const i = input ?? {};
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  const s = typeof v === "string" ? v : JSON.stringify(i);
  return `[tool ${name}] ${s.slice(0, 200)}`;
}

function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? b.text : "")).join("\n");
  return "";
}

/** Turns one transcript line into readable entries. results adds tool output; sidechain is for subagent files. */
function lineEntries(e: any, o: { results?: boolean; sidechain?: boolean } = {}): Entry[] {
  // Prompts typed while Claude was busy are stored as queued_command attachments, not user messages.
  const a = e.attachment;
  if (e.type === "attachment" && a?.type === "queued_command" && a.origin?.kind === "human" && typeof a.prompt === "string" && (!e.isSidechain || o.sidechain)) {
    return isNoise(a.prompt) ? [] : [{ role: "user", ts: e.timestamp ?? null, text: a.prompt, isPrompt: true }];
  }
  if ((e.type !== "user" && e.type !== "assistant") || (e.isSidechain && !o.sidechain) || e.isMeta || e.isCompactSummary) return [];
  const role = e.type as "user" | "assistant";
  const ts = e.timestamp ?? null;
  const content = e.message?.content;
  const out: Entry[] = [];
  if (typeof content === "string") {
    if (!isNoise(content)) out.push({ role, ts, text: content, isPrompt: role === "user" });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b?.type === "text" && b.text && !isNoise(b.text)) {
      out.push({ role, ts, text: b.text, isPrompt: role === "user" });
    } else if (b?.type === "tool_use") {
      out.push({ role, ts, text: toolBrief(b.name, b.input), isPrompt: false });
    } else if (b?.type === "tool_result" && o.results) {
      const r = resultText(b.content).trim();
      if (r) out.push({ role: "tool", ts, text: `[tool result] ${r.slice(0, 2000)}${r.length > 2000 ? "…" : ""}`, isPrompt: false });
    }
  }
  return out;
}

function* readLines(file: string): Generator<any> {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* partial line while being written */ }
  }
}

// ---------- sync: mirror live transcripts into the archive, then index ----------

function copyIfGrown(src: string, dst: string) {
  const s = fs.statSync(src);
  const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
  // Transcripts are append-only, so a larger source means new content.
  if (!d || s.size > d.size) {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
    fs.utimesSync(dst, s.atime, s.mtime); // archive mtime = last activity, used for retention
  }
}

/** Subagent transcripts live next to the session file: <project>/<session-id>/subagents/agent-*.jsonl */
const agentDir = (sessionFile: string) =>
  path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "subagents");

/** Splits text into passages short enough for the embedding model (~512 tokens). */
function toPieces(text: string, max = 1000): string[] {
  const out: string[] = [];
  let t = text.trim();
  while (t.length > max) {
    let cut = t.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(t.slice(0, cut));
    t = t.slice(cut).trim();
  }
  if (t) out.push(t);
  return out;
}

function indexFile(db: Database.Database, projectDir: string, file: string) {
  const id = path.basename(file, ".jsonl");
  const agentFiles = jsonlIn(agentDir(file)).map((f) => path.join(agentDir(file), f));
  const stats = [file, ...agentFiles].map((f) => fs.statSync(f));
  const st = { size: stats.reduce((n, s) => n + s.size, 0), mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)) };
  const prev = db.prepare("SELECT size, mtime_ms FROM sessions WHERE id = ?").get(id) as any;
  if (prev && prev.size === st.size && prev.mtime_ms === st.mtimeMs) return;

  let cwd: string | null = null, branch: string | null = null, title: string | null = null;
  let firstPrompt: string | null = null, started: string | null = null, updated: string | null = null;
  let turns = 0;
  const entries: Entry[] = [];
  for (const e of readLines(file)) {
    if (e.type === "ai-title" && typeof e.aiTitle === "string") title = e.aiTitle;
    else if (e.type === "summary" && typeof e.summary === "string") title = e.summary; // older Claude Code versions
    if (e.isSidechain) continue;
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    if (e.timestamp) { started ??= e.timestamp; updated = e.timestamp; }
    for (const en of lineEntries(e, { results: true })) {
      if (en.isPrompt) { turns++; firstPrompt ??= en.text.slice(0, 300); }
      entries.push(en);
    }
  }
  if (!entries.length) return; // empty / aborted session
  for (const f of agentFiles) {
    for (const e of readLines(f)) {
      for (const en of lineEntries(e, { results: true, sidechain: true })) {
        entries.push({ ...en, role: en.role === "tool" ? "tool" : "agent", isPrompt: false });
      }
    }
  }

  db.transaction(() => {
    deleteIndexed(db, id);
    const ins = db.prepare("INSERT INTO chunks(session_id, role, ts, text) VALUES (?,?,?,?)");
    const insTri = db.prepare("INSERT INTO chunks_tri(rowid, text) VALUES (?,?)");
    const insPiece = db.prepare("INSERT INTO pieces(session_id, role, ts, text, hash) VALUES (?,?,?,?,?)");
    for (const en of entries) {
      const text = en.text.slice(0, 8000);
      const { lastInsertRowid } = ins.run(id, en.role, en.ts, text);
      insTri.run(lastInsertRowid, text);
      // Passages for search by meaning: prose only. Tool output and tool-call one-liners are left to exact search.
      if (en.role === "tool" || text.startsWith("[tool ") || text.length < 20) continue;
      for (const p of toPieces(text)) insPiece.run(id, en.role, en.ts, p, crypto.createHash("sha1").update(p).digest("hex"));
    }
    // Claude Code's generated title is the best one-line summary of a session, for both kinds of search.
    if (title) {
      insTri.run(ins.run(id, "title", null, title).lastInsertRowid, title);
      insPiece.run(id, "title", null, title, crypto.createHash("sha1").update(title).digest("hex"));
    }
    db.prepare(`INSERT OR REPLACE INTO sessions
      (id, project_dir, cwd, git_branch, title, first_prompt, started_at, updated_at, user_turns, archive_path, size, mtime_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectDir, cwd, branch, title, firstPrompt, started, updated, turns, file, st.size, st.mtimeMs);
  })();
}

function deleteIndexed(db: Database.Database, id: string) {
  db.prepare("DELETE FROM chunks_tri WHERE rowid IN (SELECT rowid FROM chunks WHERE session_id = ?)").run(id);
  db.prepare("DELETE FROM chunks WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM pieces WHERE session_id = ?").run(id);
}

const jsonlIn = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
const subdirs = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** Deletes archived transcripts (and their index rows) with no activity in RETENTION_DAYS. */
function prune(db: Database.Database) {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const proj of subdirs(ARCHIVE_DIR)) {
    for (const f of jsonlIn(path.join(ARCHIVE_DIR, proj))) {
      const file = path.join(ARCHIVE_DIR, proj, f);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          fs.rmSync(path.join(ARCHIVE_DIR, proj, path.basename(f, ".jsonl")), { recursive: true, force: true });
        }
      } catch { /* already gone */ }
    }
  }
  const rows = db.prepare("SELECT id, archive_path FROM sessions").all() as { id: string; archive_path: string }[];
  db.transaction(() => {
    for (const r of rows) {
      if (fs.existsSync(r.archive_path)) continue;
      deleteIndexed(db, r.id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(r.id);
    }
    db.exec("DELETE FROM emb WHERE hash NOT IN (SELECT hash FROM pieces)");
  })();
}

export function sync(db: Database.Database) {
  for (const proj of subdirs(PROJECTS_DIR)) {
    for (const f of jsonlIn(path.join(PROJECTS_DIR, proj))) {
      const src = path.join(PROJECTS_DIR, proj, f), dst = path.join(ARCHIVE_DIR, proj, f);
      try { copyIfGrown(src, dst); } catch { /* vanished mid-scan */ }
      for (const a of jsonlIn(agentDir(src))) {
        try { copyIfGrown(path.join(agentDir(src), a), path.join(agentDir(dst), a)); } catch { /* vanished mid-scan */ }
      }
    }
  }
  for (const proj of subdirs(ARCHIVE_DIR)) {
    for (const f of jsonlIn(path.join(ARCHIVE_DIR, proj))) {
      try { indexFile(db, proj, path.join(ARCHIVE_DIR, proj, f)); } catch (err) { console.error(`index ${f}:`, err); }
    }
  }
  prune(db);
}

// ---------- queries ----------

const STOPWORDS = new Set(("a an and are as at be by can could did do does for from had has have how i if in into is it " +
  "its me my of on or our so that the their them then there these this those to was we were what when where which who " +
  "why will with would you your about all any some session chat conversation where we").split(" "));

/** Splits a query into terms; "quoted phrases" stay together. Unquoted filler words are dropped. */
function queryTerms(q: string): string[] {
  const all = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => ({ t: (m[1] ?? m[2]).trim(), quoted: !!m[1] })).filter((x) => x.t);
  const kept = all.filter((x) => x.quoted || !STOPWORDS.has(x.t.toLowerCase()));
  return (kept.length ? kept : all).map((x) => x.t);
}
const ftsPhrase = (t: string) => `"${t.replace(/"/g, '""')}"`;
const ROLE_WEIGHT: Record<string, number> = { title: 2, user: 1, assistant: 1, agent: 0.5, tool: 0.3 };

type TermHits = Map<string, { weight: number; best: number; snippet: string }>;

/** Sessions containing a term anywhere: whole or stemmed words, word prefixes, and substrings (3+ chars). */
function termSessions(db: Database.Database, term: string, noTitles = false): TermHits {
  const out: TermHits = new Map();
  const add = (rows: { session_id: string; role: string; snip: string }[]) => {
    for (const r of rows) {
      if (noTitles && r.role === "title") continue;
      const w = ROLE_WEIGHT[r.role] ?? 1;
      const h = out.get(r.session_id);
      if (!h) out.set(r.session_id, { weight: w, best: w, snippet: r.snip });
      else {
        h.weight += w;
        if (w > h.best) { h.best = w; h.snippet = r.snip; } // prefer a snippet from the conversation over tool output
      }
    }
  };
  add(db.prepare(`SELECT session_id, role, snippet(chunks, 3, '«', '»', '…', 12) AS snip
    FROM chunks WHERE chunks MATCH ?`).all([...term].length >= 3 ? `${ftsPhrase(term)} *` : ftsPhrase(term)) as any[]);
  if ([...term].length >= 3) {
    add(db.prepare(`SELECT c.session_id, c.role, snippet(chunks_tri, 0, '«', '»', '…', 12) AS snip
      FROM chunks_tri JOIN chunks c ON c.rowid = chunks_tri.rowid WHERE chunks_tri MATCH ?`).all(ftsPhrase(term)) as any[]);
  }
  return out;
}

/** Best-matching passage per session by meaning (cosine similarity of normalized embeddings). */
async function semanticRank(db: Database.Database, query: string, noTitles = false) {
  const [q] = await embed([query], true);
  const best = new Map<string, { sim: number; pieceId: number }>();
  for (const [id, sid, buf] of db.prepare(`SELECT p.id, p.session_id, e.vec FROM pieces p
      JOIN emb e ON e.hash = p.hash ${noTitles ? "WHERE p.role != 'title'" : ""}`).raw().iterate() as Iterable<[number, string, Buffer]>) {
    const v = new Float32Array(new Uint8Array(buf).buffer);
    let sim = 0;
    for (let i = 0; i < v.length; i++) sim += v[i] * q[i];
    const b = best.get(sid);
    if (!b || sim > b.sim) best.set(sid, { sim, pieceId: id });
  }
  const text = db.prepare("SELECT text FROM pieces WHERE id = ?").pluck();
  return [...best].map(([id, b]) => ({ id, sim: b.sim, snippet: (text.get(b.pieceId) as string).slice(0, 200) }))
    .sort((a, b) => b.sim - a.sim);
}

/** Embeds passages that don't have a vector yet. No-op if the model isn't installed. */
export async function embedPending(db: Database.Database, progress?: (done: number, total: number) => void) {
  if (!modelPresent()) return 0;
  const rows = db.prepare(`SELECT DISTINCT p.hash, p.text FROM pieces p
    LEFT JOIN emb e ON e.hash = p.hash WHERE e.hash IS NULL`).all() as { hash: string; text: string }[];
  const ins = db.prepare("INSERT OR IGNORE INTO emb(hash, vec) VALUES (?, ?)");
  for (let i = 0; i < rows.length; i += 32) {
    const batch = rows.slice(i, i + 32);
    const vecs = await embed(batch.map((r) => r.text));
    db.transaction(() => batch.forEach((r, j) => ins.run(r.hash, Buffer.from(vecs[j].buffer))))();
    progress?.(Math.min(i + 32, rows.length), rows.length);
  }
  return rows.length;
}

export type Hit = Session & { snippets: string[]; matched: string[] };
export type SearchMode = "hybrid" | "exact" | "semantic";
export type SearchResult = { hits: Hit[]; total: number; notes: string[] };

/** A meaning match counts at this similarity, or within SIM_SPREAD of the query's best match (never below SIM_FLOOR). */
const MIN_SIM = Number(process.env.CLAUDE_SESSIONS_MIN_SIMILARITY ?? 0.68);
const SIM_SPREAD = 0.08, SIM_FLOOR = 0.6;
const RRF_K = 60;

export async function search(db: Database.Database, o: {
  query?: string; project?: string; since?: string; limit?: number; offset?: number; mode?: SearchMode;
  ignoreTitles?: boolean; // for eval, which uses titles as paraphrased queries
}): Promise<SearchResult> {
  const limit = o.limit ?? 20, offset = o.offset ?? 0, mode = o.mode ?? "hybrid";
  const getS = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const keep = (s: Session | undefined): s is Session => !!s &&
    (!o.project || `${s.cwd ?? ""} ${s.project_dir}`.toLowerCase().includes(o.project.toLowerCase())) &&
    (!o.since || (s.updated_at ?? "") >= o.since);
  const notes: string[] = [];

  if (!o.query?.trim()) {
    const rows = (db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Session[]).filter(keep);
    return { hits: rows.slice(offset, offset + limit).map((s) => ({ ...s, snippets: [], matched: [] })), total: rows.length, notes };
  }

  // Exact: a session matches when every term appears somewhere in it, not necessarily in the same message.
  // With 3+ terms (usually a description, not keywords) sessions missing one term are kept too, ranked by score.
  const terms = queryTerms(o.query);
  let exact: { id: string; n: number; score: number; snippets: string[] }[] = [];
  let partial = false;
  if (mode !== "semantic") {
    const per = terms.map((t) => termSessions(db, t, o.ignoreTitles));
    // BM25 at session level: rarer terms count for more, repeats saturate, and long sessions (which contain most
    // common words somewhere) don't win just by being long.
    const lens = new Map((db.prepare("SELECT session_id, count(*) FROM chunks GROUP BY session_id").raw().all() as [string, number][]));
    const avgLen = [...lens.values()].reduce((a, b) => a + b, 0) / Math.max(1, lens.size);
    const idf = per.map((m) => Math.log(1 + (lens.size - m.size + 0.5) / (m.size + 0.5)));
    const K1 = 1.2, B = 0.75;
    for (const id of new Set(per.flatMap((m) => [...m.keys()]))) {
      if (!keep(getS.get(id) as Session | undefined)) continue;
      const norm = K1 * (1 - B + (B * (lens.get(id) ?? avgLen)) / avgLen);
      const hits = per.map((m, i) => ({ h: m.get(id), idf: idf[i] })).filter((x) => !!x.h);
      const score = hits.reduce((n, x) => n + (x.idf * x.h!.weight * (K1 + 1)) / (x.h!.weight + norm), 0);
      exact.push({ id, n: hits.length, score, snippets: hits.map((x) => x.h!.snippet) });
    }
    const need = terms.length >= 3 ? terms.length - 1 : terms.length;
    const close = exact.filter((e) => e.n >= need);
    partial = !exact.some((e) => e.n === terms.length) && exact.length > 0;
    if (partial) notes.push(`No session contains all of: ${terms.join(", ")}. Showing sessions that contain some of them.`);
    exact = close.length ? close.sort((a, b) => b.score - a.score) : exact.sort((a, b) => b.n - a.n || b.score - a.score);
  }

  let semantic: { id: string; sim: number; snippet: string }[] = [];
  if (mode !== "exact") {
    if (!modelPresent()) notes.push(`Search by meaning is off: no model in ${modelPath()} (see README). Exact matches only.`);
    else {
      const ranked = await semanticRank(db, o.query, o.ignoreTitles);
      const bar = Math.max(SIM_FLOOR, Math.min(MIN_SIM, (ranked[0]?.sim ?? 1) - SIM_SPREAD));
      semantic = ranked.filter((r) => r.sim >= bar && keep(getS.get(r.id) as Session | undefined)).slice(0, 50);
    }
  }

  // Reciprocal rank fusion: sessions that rank well in both lists rise to the top.
  const fused = new Map<string, { score: number; matched: string[]; snippets: string[] }>();
  const at = (id: string) => fused.get(id) ?? fused.set(id, { score: 0, matched: [], snippets: [] }).get(id)!;
  exact.forEach((e, i) => {
    const f = at(e.id);
    f.score += 1 / (RRF_K + i);
    f.matched.push(e.n === terms.length ? "exact" : `words ${e.n}/${terms.length}`);
    f.snippets.push(...e.snippets);
  });
  semantic.forEach((s, i) => {
    const f = at(s.id);
    f.score += 1 / (RRF_K + i);
    f.matched.push(`meaning ${s.sim.toFixed(2)}`);
    f.snippets.push(s.snippet);
  });
  const ranked = [...fused].sort((a, b) => b[1].score - a[1].score);
  const hits = ranked.slice(offset, offset + limit).map(([id, f]) => ({
    ...(getS.get(id) as Session), matched: f.matched, snippets: f.snippets.slice(0, 3).map((s) => s.replace(/\s+/g, " ")),
  }));
  return { hits, total: ranked.length, notes };
}

export function findSession(db: Database.Database, idOrPrefix: string): Session {
  const rows = db.prepare("SELECT * FROM sessions WHERE id LIKE ? LIMIT 2").all(`${idOrPrefix}%`) as Session[];
  if (!rows.length) throw new Error(`No session matching "${idOrPrefix}"`);
  if (rows.length > 1) throw new Error(`"${idOrPrefix}" is ambiguous; use more characters of the id`);
  return rows[0];
}

export function render(s: Session, o: { offset?: number; maxChars?: number; toolResults?: boolean }) {
  const all: Entry[] = [];
  for (const e of readLines(s.archive_path)) all.push(...lineEntries(e, { results: o.toolResults }));
  const max = o.maxChars ?? 20000;
  let i = o.offset ?? 0, used = 0;
  const parts: string[] = [];
  for (; i < all.length; i++) {
    const en = all[i];
    const block = `${en.role === "user" ? "USER" : en.role === "tool" ? "TOOL" : "CLAUDE"}: ${en.text}`;
    if (used + block.length > max && parts.length) break;
    parts.push(block);
    used += block.length;
  }
  return { text: parts.join("\n\n"), nextOffset: i < all.length ? i : null, total: all.length };
}

/** Puts the transcript back where `claude --resume` looks for it, in case cleanup deleted it. */
export function restore(s: Session): string {
  const target = path.join(PROJECTS_DIR, s.project_dir, `${s.id}.jsonl`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(s.archive_path, target);
  }
  return target;
}
