#!/usr/bin/env node
// Used by the SessionEnd hook (`index`), for manual checks (`search <words>`), for measuring search quality (`eval`)
// and for wiring it into Claude Code (`setup`).
import { embedPending, openDb, search, sync } from "./store.js";
import { modelPath, modelPresent } from "./embed.js";
import { runEval } from "./eval.js";
import { setup } from "./setup.js";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "setup") {
  setup(rest.includes("--apply"));
} else if (cmd === "index" || cmd === "search" || cmd === "eval") {
  const db = openDb();
  sync(db);
  await embedPending(db, process.stderr.isTTY
    ? (done, total) => process.stderr.write(`\rembedding ${done}/${total}${done === total ? "\n" : ""}`)
    : undefined);
  if (cmd === "search") {
    const r = await search(db, { query: rest.join(" "), limit: 10 });
    console.log(`${r.total} matching session(s)`);
    for (const n of r.notes) console.log(n);
    for (const h of r.hits) {
      console.log(`${h.id}  ${h.updated_at ?? ""}  ${h.cwd ?? h.project_dir}  [${h.matched.join(", ")}]\n   ${(h.snippets[0] ?? h.first_prompt ?? "").slice(0, 160)}`);
    }
  } else if (cmd === "eval") {
    if (!modelPresent()) console.log(`(no model in ${modelPath()}: meaning-based checks are skipped)\n`);
    await runEval(db, Number(rest[0] ?? 300));
  }
} else {
  console.error("usage: claude-sessions setup [--apply] | index | search <words> | eval [samples]");
  process.exit(1);
}
