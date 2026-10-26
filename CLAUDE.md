# claude-sessions: notes for working on this repo

Local-only MCP server + CLI that lets Claude Code search, read and resume past Claude Code sessions.
README.md is for users, INSTALL.md is the install checklist Claude follows. This file is for changing the code.

## Requirements
- Local only. No network calls, no sync, no remote storage. The embedding model is installed by hand and
  `allowRemoteModels` is off, so nothing is ever downloaded at runtime.
- Claude itself uses it: "find the session where…" → `search_sessions`; "open it" → `open_session`.
- Survives Claude Code's transcript cleanup (`cleanupPeriodDays`, which deletes at startup); keeps its own archive
  for `CLAUDE_SESSIONS_RETENTION_DAYS` (default 365) and prunes after that.

## Layout
- `src/store.ts` — mirrors `~/.claude/projects/<slug>/<uuid>.jsonl` (+ `<uuid>/subagents/*.jsonl`) into
  `~/.claude-sessions/archive/<slug>/`, indexes into `~/.claude-sessions/index.db`, search / render / restore / prune.
  Tables: `sessions`, `chunks` (FTS5 porter), `chunks_tri` (FTS5 trigram, same rowids), `pieces` (passages for
  embeddings), `emb` (vectors keyed by text sha1).
- `src/embed.ts` — bge-small-en-v1.5 via @huggingface/transformers, CLS pooling, normalized; query prefix on queries only.
- `src/server.ts` — MCP stdio server: `search_sessions`, `read_session`, `open_session`. Each call syncs incrementally.
- `src/launch.ts` — `claude --resume <id>` in the original cwd: tmux new-window if `$TMUX`, else a split of the
  current iTerm pane (matched by `$ITERM_SESSION_ID`), else macOS Terminal, else gnome-terminal / konsole /
  x-terminal-emulator, else returns the command.
- `src/setup.ts` — `claude-sessions setup [--apply]`: settings.json changes + MCP registration with absolute paths.
- `src/eval.ts` — `claude-sessions eval`: recall on the real index (see below).
- `src/cli.ts` — `setup`, `index` (SessionEnd hook), `search <words>`, `eval [samples]`.

## Search design
- Exact: each term is matched per session (word FTS with prefix, plus trigram substring for 3+ chars); a session
  matches when every term appears anywhere in it. With 3+ terms, sessions missing one term are kept. Unquoted
  stopwords are dropped. Ranking: BM25 at session level (k1 1.2, b 0.75), role weights title 2 / user, assistant 1 /
  agent 0.5 / tool 0.3.
- Meaning: best passage per session by cosine; kept if ≥ 0.68 or within 0.08 of the query's best (floor 0.6).
  Thresholds were calibrated with `eval` using session titles as paraphrased queries.
- Fusion: reciprocal rank fusion (k 60). Each hit reports how it matched.
- Session titles (`ai-title` entries) are indexed for both; `eval` passes `ignoreTitles` so the paraphrase test stays honest.

## Transcript format (undocumented; re-check after Claude Code updates)
- Titles: `{"type":"ai-title","aiTitle":…}` (older versions: `summary`).
- Prompts typed while Claude is busy: `attachment` entries with `attachment.type === "queued_command"`.
- Skipped: `isMeta`, `isCompactSummary`, `<command-…>`, `<local-command-…>`, `<task-notification>`,
  `<bash-stdout>`/`<bash-stderr>`, `<system-reminder>`.
- Subagent files have `isSidechain: true` on every line; they're read with `sidechain: true` and indexed as role `agent`.

## Gotchas
- Dependency versions are pinned exactly. zod must dedupe with the SDK's zod (both 3.25.76); two copies make `tsc`
  run out of memory on `registerTool` types.
- The MCP server talks over stdout: never `console.log` in server code paths, use `console.error`.
- Bumping `SCHEMA_VERSION` rebuilds every table except `emb` (vectors only depend on the model), so it's cheap.
- After changing search, run `claude-sessions eval` before and after and compare; also try a few plain-English queries
  by hand, since good averages can hide ranking bugs.
