// Measures search recall on the real index: take text from a known session, search for it, check the session comes back.
import type Database from "better-sqlite3";
import { modelPresent } from "./embed.js";
import { search, type SearchMode } from "./store.js";

export async function runEval(db: Database.Database, samples: number) {
  let seed = 7; // fixed seed so runs are comparable
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  const pick = <T>(a: T[]) => a[rnd(a.length)];
  const words = (t: string) => t.match(/[A-Za-z][A-Za-z0-9]{5,}/g) ?? [];
  const textOf = (id: string, roles: string[]) => (db.prepare(
    `SELECT text FROM chunks WHERE session_id = ? AND role IN (${roles.map(() => "?").join(",")})`).pluck().all(id, ...roles)) as string[];
  const ids = db.prepare("SELECT id FROM sessions").pluck().all() as string[];

  const res = new Map<string, [number, number]>();
  const check = async (label: string, id: string, query: string, top: number, mode: SearchMode = "hybrid") => {
    const r = await search(db, { query, limit: top, mode, ignoreTitles: true });
    const t = res.get(label) ?? [0, 0];
    t[0] += +r.hits.some((h) => h.id === id); t[1]++;
    res.set(label, t);
  };

  for (let i = 0; i < samples; i++) {
    const id = pick(ids);
    const msgs = textOf(id, ["user", "assistant"]);
    if (msgs.length < 4) continue;
    const w1 = words(pick(msgs)), w2 = words(pick(msgs));
    if (!w1.length || !w2.length) continue;
    const a = pick(w1), b = pick(w2);
    await check("1 word, anywhere in results", id, a, 500, "exact");
    await check("1 word, top 10", id, a, 10);
    await check("2 words from different messages, anywhere", id, `${a} ${b}`, 500, "exact");
    await check("2 words from different messages, top 10", id, `${a} ${b}`, 10);
    await check("start of a word (4 letters)", id, a.slice(0, 4), 500, "exact");
    await check("middle of a word", id, a.slice(1, -1), 500, "exact");
    const tool = textOf(id, ["tool"]).flatMap(words);
    if (tool.length) await check("word from command output", id, pick(tool), 500, "exact");
    const agent = textOf(id, ["agent"]).flatMap(words);
    if (agent.length) await check("word from subagent work", id, pick(agent), 500, "exact");
  }
  // Titles are written by Claude Code in its own words and aren't indexed, so they work as paraphrased queries.
  const titled = db.prepare("SELECT id, title FROM sessions WHERE title IS NOT NULL").all() as { id: string; title: string }[];
  for (const t of titled) {
    await check("title as query, exact only, top 10", t.id, t.title, 10, "exact");
    if (modelPresent()) {
      await check("title as query, meaning only, top 10", t.id, t.title, 10, "semantic");
      await check("title as query, hybrid, top 10", t.id, t.title, 10);
    }
  }
  for (const [k, [ok, n]] of res) console.log(`${k.padEnd(42)} ${String(Math.round((100 * ok) / n)).padStart(3)}%  (${ok}/${n})`);
}
