#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { embedPending, findSession, openDb, render, restore, search, sync, type Hit } from "./store.js";
import { launch } from "./launch.js";

const db = openDb();
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(String(e instanceof Error ? e.message : e)), isError: true });

function fmt(h: Hit): string {
  const lines = [
    `id: ${h.id}`,
    `  dir: ${h.cwd ?? h.project_dir}${h.git_branch ? `  (branch ${h.git_branch})` : ""}`,
    `  when: ${h.started_at ?? "?"} → ${h.updated_at ?? "?"}  · ${h.user_turns} prompts`,
  ];
  if (h.title) lines.push(`  title: ${h.title}`);
  if (h.matched.length) lines.push(`  matched by: ${h.matched.join(", ")}`);
  if (h.first_prompt) lines.push(`  first prompt: ${h.first_prompt.replace(/\s+/g, " ").slice(0, 200)}`);
  for (const s of h.snippets) lines.push(`  match: ${s}`);
  return lines.join("\n");
}

const server = new McpServer({ name: "claude-sessions", version: "1.0.0" });

server.registerTool("search_sessions", {
  description:
    "Search the user's past Claude Code sessions (all projects, stored locally). Use this whenever the user refers to " +
    "a previous/earlier/past session, chat or conversation ('the session where we fixed X', 'what did we decide about Y', " +
    "'my last chat in this repo'). Leave query empty to list the most recent sessions. Results include session ids for " +
    "read_session and open_session. Note the current session will also appear in results.\n" +
    "Search is hybrid. Exact: a session matches when every word appears anywhere in it (any message, command output or " +
    "subagent work); partial words and identifiers match too; use \"quotes\" for a phrase. Meaning: finds sessions that " +
    "talk about the same thing in different words. Each result says how it matched.\n" +
    "For good recall: if results look wrong or thin, search again with other wording (synonyms, the specific error text, " +
    "file or table name, hostname, a person's name) before telling the user it isn't there. To find ALL sessions on a topic, " +
    "read `total` and page with offset.",
  inputSchema: {
    query: z.string().optional().describe("Words, identifiers, \"phrases\" or a plain description. Omit to list recent."),
    project: z.string().optional().describe("Substring of the project directory, e.g. 'my-api' or the current repo name"),
    since: z.string().optional().describe("Only sessions active on/after this ISO date, e.g. 2026-10-01"),
    mode: z.enum(["hybrid", "exact", "semantic"]).optional()
      .describe("hybrid (default): exact + meaning. exact: only literal matches. semantic: only by meaning."),
    limit: z.number().int().min(1).max(200).optional().describe("Max sessions to return (default 20)"),
    offset: z.number().int().min(0).optional().describe("Skip this many results, for paging (default 0)"),
  },
}, async (a) => {
  try {
    sync(db);
    await embedPending(db);
    const r = await search(db, a);
    const from = a.offset ?? 0;
    const head = [`${r.total} matching session(s)` + (r.total ? `, showing ${from + 1}-${from + r.hits.length}` : "") +
      (from + r.hits.length < r.total ? ` · next offset=${from + r.hits.length}` : ""), ...r.notes].join("\n");
    return text([head, ...r.hits.map(fmt)].join("\n\n"));
  } catch (e) { return fail(e); }
});

server.registerTool("read_session", {
  description:
    "Read a past session's transcript (user prompts, Claude replies, tool calls) so you can answer questions about it or " +
    "continue its work inside the current session. Paged: if next_offset is returned and you need more, call again with it.",
  inputSchema: {
    session_id: z.string().describe("Full id or a unique prefix (8+ chars)"),
    offset: z.number().int().min(0).optional().describe("Entry index to start from (default 0)"),
    max_chars: z.number().int().min(1000).max(100000).optional().describe("Size of this page (default 20000)"),
    include_tool_results: z.boolean().optional().describe("Include truncated tool output (default false)"),
  },
}, async (a) => {
  try {
    sync(db);
    const s = findSession(db, a.session_id);
    const r = render(s, { offset: a.offset, maxChars: a.max_chars, toolResults: a.include_tool_results });
    const head = `session ${s.id} · ${s.cwd ?? s.project_dir} · entries ${a.offset ?? 0}-${(r.nextOffset ?? r.total) - 1} of ${r.total}` +
      (r.nextOffset !== null ? ` · next_offset=${r.nextOffset}` : " · end");
    return text(`${head}\n\n${r.text}`);
  } catch (e) { return fail(e); }
});

server.registerTool("open_session", {
  description:
    "Resume a past session as a real Claude Code session: restores its transcript if Claude Code's cleanup deleted it, " +
    "then launches `claude --resume <id>` in its original directory in a new tmux window, an iTerm split pane, or a terminal window. " +
    "Use when the user says to open, resume or switch to a past session. (To pull its context into THIS session instead, use read_session.)",
  inputSchema: {
    session_id: z.string().describe("Full id or a unique prefix (8+ chars)"),
    mode: z.enum(["auto", "tmux", "terminal", "print"]).optional()
      .describe("auto (default): tmux if inside tmux, else an iTerm split pane or a new terminal window. print: just return the command."),
  },
}, async (a) => {
  try {
    sync(db);
    const s = findSession(db, a.session_id);
    restore(s);
    return text(launch(s, a.mode ?? "auto"));
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
