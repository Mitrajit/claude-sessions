# Installing claude-sessions (steps for Claude Code)

Follow these steps in order. Run the commands as written; ask the user only where a step says to.
Don't change anything outside this repo, `~/.claude-sessions/`, `~/.claude/settings.json` and the MCP registration.

1. **Prerequisites.** `node -v` must be 18 or newer (tested on 22). Also needs `git`, `claude`, and macOS or Linux.
   If this repo isn't at `~/code/claude-sessions` yet:
   `git clone https://github.com/Mitrajit/claude-sessions ~/code/claude-sessions`

2. **Build and install.**
   ```sh
   cd ~/code/claude-sessions && npm ci && npm run build && npm install -g .
   ```
   `npm install -g .` links to this folder, so keep the repo where it is.

3. **Preview the config changes.** Run `claude-sessions setup` and show the user its output as-is. It lists the
   exact `~/.claude/settings.json` changes (1-year transcript retention, a SessionEnd hook, permission to use the
   search and read tools without prompting) and the MCP registration command. Ask the user to approve.

4. **Apply** (only after approval). Run `claude-sessions setup --apply`. It backs up `settings.json` first.
   Then `claude mcp get claude-sessions` must show `Connected`.

5. **Index and sanity-check.** Run `claude-sessions index`, then `claude-sessions search <a word from one of the
   user's recent sessions>` and show the top results.

6. **Search by meaning (optional).** Ask the user if they want it. **Don't download the model yourself** unless
   the user explicitly asks you to. They should put these four files from
   https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main into
   `~/.claude-sessions/models/Xenova/bge-small-en-v1.5/`, keeping the `onnx/` subfolder:
   `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`.
   If they already have it in the Hugging Face cache (`~/.cache/huggingface/hub/models--Xenova--bge-small-en-v1.5/snapshots/*/`),
   copy those four files over with `cp -L`. Then run `claude-sessions index` again (a few minutes the first time).

7. **Verify.** Run `claude-sessions eval` and show the user the table. Every "anywhere in results" line should be
   100%. "Top 10" lines for single common words are expected to be lower: many sessions legitimately contain them.

8. **Tell the user:**
   - Restart any open Claude Code sessions to load the tools, then try "find the session where we …".
   - Sessions are kept for 365 days (`CLAUDE_SESSIONS_RETENTION_DAYS`). Transcripts Claude Code already deleted
     before this install can't be recovered.
   - Optional line for `~/.claude/CLAUDE.md`: "When I refer to a previous session or chat, use the claude-sessions
     tools to find it instead of asking me for context."

## Troubleshooting

- **`env: node: No such file or directory` in hook output:** re-run `claude-sessions setup --apply`. It writes
  absolute paths to node.
- **After switching Node versions (nvm):** repeat steps 2 and 4.
- **macOS asks to let the app control iTerm or Terminal** the first time a session is opened: allow it, or use
  `open_session` with `mode: "print"` to just get the command.
