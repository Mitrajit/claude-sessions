# claude-sessions

Local-only search and resume for Claude Code sessions, exposed to Claude itself over MCP.
Nothing leaves the machine: transcripts are mirrored to `~/.claude-sessions/archive/` (0600 files)
and indexed in `~/.claude-sessions/index.db` (SQLite FTS5).

## Tools Claude gets

- `search_sessions` — hybrid search across every project; empty query lists recent sessions; filter by project substring or date; returns the total match count and pages with `offset`.
  - **Exact**: a session matches when every word appears anywhere in it (any message, command output, subagent work,
    or Claude Code's generated title). Whole words, stemmed forms, word starts and any substring of 3+ characters all
    match; `"quotes"` for phrases. Filler words are ignored unless quoted. With 3+ words, sessions missing one word are
    kept too (labelled `words 4/5`). Ranking is BM25 at session level, so long sessions don't win just by being long.
  - **Meaning** (optional local model, see below): finds sessions about the same thing in different words.
  - The two rankings are merged (reciprocal rank fusion); each result says how it matched.
- `read_session` — paged transcript, so Claude can answer questions about an old session or carry its context into the current one.
- `open_session` — restores the transcript if Claude Code's cleanup deleted it, then runs `claude --resume <id>` in the original directory in a new tmux window (if you're in tmux), a split pane beside the current one (iTerm), or a new terminal window (macOS Terminal, GNOME Terminal, Konsole). Otherwise it returns the command.

## Install

**With Claude Code** (recommended): paste this into Claude Code.

```
Clone https://github.com/Mitrajit/claude-sessions into ~/code/claude-sessions and follow its INSTALL.md exactly; show me the settings.json diff before applying it.
```

**By hand:**

```sh
git clone https://github.com/Mitrajit/claude-sessions ~/code/claude-sessions && cd ~/code/claude-sessions
npm ci && npm run build && npm install -g .
claude-sessions setup            # preview the settings.json + MCP changes for this machine
claude-sessions setup --apply    # make them (settings.json is backed up first)
claude-sessions index
```

`setup` adds three things to `~/.claude/settings.json`: `cleanupPeriodDays: 365`, a `SessionEnd` hook that archives
each session as it ends, and permission to use `search_sessions` / `read_session` without prompting. It also registers
the MCP server. It uses absolute paths to `node`, because hooks and MCP servers don't always inherit a `PATH` that has
it (nvm, desktop app). Every tool call also syncs, so the hook is a safety net, not a requirement. `open_session` is
left off the allow list so opening a terminal still asks first.

Optional line for `~/.claude/CLAUDE.md`:

> When I refer to a previous session or chat, use the claude-sessions tools to find it instead of asking me for context.

Check it from a shell: `claude-sessions search retry webhook`

## Search by meaning (manual model install)

The model is never downloaded by the tool. Put these four files from
https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main into
`~/.claude-sessions/models/Xenova/bge-small-en-v1.5/`, keeping the `onnx/` subfolder:

```
config.json
tokenizer.json
tokenizer_config.json
onnx/model_quantized.onnx      (~34 MB)
```

Then run `claude-sessions index` once to embed existing sessions; after that new messages are embedded on each
sync. Without the model, search is exact-only and says so.

## Measuring search quality

`claude-sessions eval [samples]` samples text from real sessions, searches for it, and reports how often the source
session comes back (exact words, word starts, substrings, command output, subagent work, and session titles as
paraphrased queries). Re-run it after changes and after Claude Code updates, since the transcript format is undocumented.

## Env vars

- `CLAUDE_CONFIG_DIR` — Claude Code's config dir (default `~/.claude`)
- `CLAUDE_SESSIONS_HOME` — archive + index location (default `~/.claude-sessions`)
- `CLAUDE_BIN` — command used to resume (default `claude`)
- `CLAUDE_SESSIONS_RETENTION_DAYS` — archived sessions idle longer than this are deleted (default 365)
- `CLAUDE_SESSIONS_MODEL_DIR` — where the embedding model lives (default `~/.claude-sessions/models`)
- `CLAUDE_SESSIONS_MIN_SIMILARITY` — cutoff for meaning-only matches (default 0.68, calibrated with `eval`)

## Notes

- Resume works per directory: if the original folder was moved or deleted, `open_session` says so
  and gives the command to run once it's back at that path. `read_session` works regardless.
- Slash-command noise is skipped. Tool output and subagent work are indexed for exact search but rank below the
  conversation itself; tool output can be read with `include_tool_results`.
- Transcripts are plain text and can contain anything you pasted, including secrets.
