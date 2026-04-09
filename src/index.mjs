#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PlaneClient,
  appendTaskLineToSection,
  assertRepoConfig,
  ensureDetailsEntry,
  findRepoRoot,
  findTaskMatches,
  loadConfig,
  moveTaskLineBetweenSections,
  normalizeSections,
  parseMarkdownTasks,
  pickProjectId,
  readState,
  resolveBacklogFiles,
  sectionToPlaneStateId,
  sha256,
  summarizePlan,
  upsertIssueIdMarker,
  writeState,
  applyTaskLineUpdate,
} from "./core.mjs";
import fs from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";

function toolError(message) {
  const e = new Error(message);
  e.name = "ToolError";
  return e;
}

function loadEnv() {
  // Load from current working directory first (so users can run from repo),
  // then from the server package directory as a fallback.
  // quiet: required — dotenv v17+ logs to stdout by default and breaks MCP stdio JSON-RPC.
  const opts = { quiet: true };
  dotenv.config({ ...opts, path: path.join(process.cwd(), ".env") });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenv.config({ ...opts, path: path.join(__dirname, "..", ".env") });
}

async function getCtx(repoPath) {
  const start = repoPath ? path.resolve(repoPath) : process.cwd();
  const repoRoot = await findRepoRoot(start);
  if (!repoRoot) throw toolError("Not inside a git repo (could not find .git). Provide repoPath or run from a repo.");

  const { merged, repo, globalPath, repoPath: rp } = await loadConfig(repoRoot);
  assertRepoConfig(repo);
  const client = new PlaneClient(merged);
  const backlogFiles = await resolveBacklogFiles(repoRoot, repo.backlogFiles);
  if (!backlogFiles.length) throw toolError("No backlog files matched backlogFiles patterns.");

  const projects = await client.listProjects(repo.workspaceSlug);
  const projectId = pickProjectId(projects, repo);
  if (!projectId) throw toolError("Could not resolve projectId (check projectId or projectSlug in .plane-sync.json).");

  const sections = normalizeSections(repo);
  const state = await readState(repoRoot);
  return { repoRoot, repo, merged, globalPath, repoConfigPath: rp, client, backlogFiles, projectId, sections, state };
}

async function parseAllBacklogs(backlogFiles) {
  const parsedByFile = new Map();
  const allTasks = [];
  for (const fp of backlogFiles) {
    const md = await fs.readFile(fp, "utf8");
    const parsed = parseMarkdownTasks(md, fp);
    parsedByFile.set(fp, parsed);
    allTasks.push(...parsed.tasks);
  }
  return { parsedByFile, allTasks };
}

async function cmdNew({ repoPath, title, description, toSection, dryRun }) {
  const ctx = await getCtx(repoPath);
  const actions = [];

  actions.push({ type: "plane:create", workspaceSlug: ctx.repo.workspaceSlug, projectId: ctx.projectId, title });
  let createdId = null;
  if (!dryRun) {
    const created = await ctx.client.createIssue(ctx.repo.workspaceSlug, ctx.projectId, {
      name: title,
      ...(description ? { description } : {}),
    });
    createdId = created?.id ? String(created.id) : null;
    if (!createdId) throw toolError("Plane createIssue returned no id");
  } else {
    createdId = "DRY_RUN";
  }

  const targetSection = toSection ?? ctx.sections.inbox;
  const fp = ctx.backlogFiles[0];
  const md = await fs.readFile(fp, "utf8");
  const parsed = parseMarkdownTasks(md, fp);
  const lines = parsed.lines.slice();
  const taskLine = upsertIssueIdMarker(`- [ ] ${title}`, createdId);
  appendTaskLineToSection(lines, targetSection, taskLine);
  actions.push({ type: "md:append", filePath: fp, title, toSection: targetSection });
  if (!dryRun) await fs.writeFile(fp, lines.join("\n"), "utf8");

  await ensureDetailsEntry({
    repoRoot: ctx.repoRoot,
    repoCfg: ctx.repo,
    issueId: createdId,
    title,
    description: description ?? "",
    dryRun,
    actions,
  });

  return { ok: true, issueId: createdId, summary: summarizePlan(actions, { cwd: ctx.repoRoot }) };
}

async function cmdSetStatus({ repoPath, query, toSection, dryRun }) {
  const ctx = await getCtx(repoPath);
  const { parsedByFile, allTasks } = await parseAllBacklogs(ctx.backlogFiles);
  const matches = findTaskMatches(allTasks, query);
  if (matches.length !== 1) throw toolError(`Expected 1 match, got ${matches.length}`);
  const t = matches[0];
  if (!t.issueId) throw toolError("Matched task has no plane issueId yet (run sync first).");

  const actions = [];
  const parsed = parsedByFile.get(t.filePath);
  const lines = parsed.lines.slice();
  if (t.headings[t.headings.length - 1] !== toSection) {
    moveTaskLineBetweenSections(lines, t.lineIndex, toSection);
    actions.push({ type: "md:move", filePath: t.filePath, title: t.title, toSection });
    if (!dryRun) await fs.writeFile(t.filePath, lines.join("\n"), "utf8");
  }

  const stateId = sectionToPlaneStateId(ctx.repo, toSection);
  if (stateId) {
    actions.push({ type: "plane:update", workspaceSlug: ctx.repo.workspaceSlug, issueId: t.issueId, fields: ["state_id"] });
    if (!dryRun) await ctx.client.updateIssue(ctx.repo.workspaceSlug, ctx.projectId, t.issueId, { state_id: stateId });
  }

  return { ok: true, issueId: t.issueId, summary: summarizePlan(actions, { cwd: ctx.repoRoot }) };
}

async function cmdComment({ repoPath, query, text, dryRun }) {
  const ctx = await getCtx(repoPath);
  const { allTasks } = await parseAllBacklogs(ctx.backlogFiles);
  const matches = findTaskMatches(allTasks, query);
  if (matches.length !== 1) throw toolError(`Expected 1 match, got ${matches.length}`);
  const t = matches[0];
  if (!t.issueId) throw toolError("Matched task has no plane issueId yet (run sync first).");
  const actions = [];

  actions.push({ type: "plane:comment", issueId: t.issueId });
  if (!dryRun) {
    await ctx.client.createIssueComment(
      ctx.repo.workspaceSlug,
      ctx.projectId,
      t.issueId,
      { comment: text },
      ctx.merged.apiPaths ?? {},
    );
  }

  await ensureDetailsEntry({
    repoRoot: ctx.repoRoot,
    repoCfg: ctx.repo,
    issueId: t.issueId,
    title: t.title,
    description: `**Comment**\n\n${text}`,
    dryRun,
    actions,
  });

  return { ok: true, issueId: t.issueId, summary: summarizePlan(actions, { cwd: ctx.repoRoot }) };
}

async function cmdTake({ repoPath, query, toSection, comment, dryRun }) {
  const ctx = await getCtx(repoPath);
  const { parsedByFile, allTasks } = await parseAllBacklogs(ctx.backlogFiles);
  const matches = findTaskMatches(allTasks, query);
  if (matches.length !== 1) throw toolError(`Expected 1 match, got ${matches.length}`);
  const t = matches[0];
  if (!t.issueId) throw toolError("Matched task has no plane issueId yet (run sync first).");

  const actions = [];
  const targetSection = toSection ?? ctx.sections.doing;
  const parsed = parsedByFile.get(t.filePath);
  const lines = parsed.lines.slice();
  if (t.headings[t.headings.length - 1] !== targetSection) {
    moveTaskLineBetweenSections(lines, t.lineIndex, targetSection);
    actions.push({ type: "md:move", filePath: t.filePath, title: t.title, toSection: targetSection });
    if (!dryRun) await fs.writeFile(t.filePath, lines.join("\n"), "utf8");
  }

  const me = await ctx.client.me();
  const myId = me?.id ? String(me.id) : null;
  const fields = [];
  const body = {};
  const stateId = sectionToPlaneStateId(ctx.repo, targetSection);
  if (stateId) {
    body.state_id = stateId;
    fields.push("state_id");
  }
  if (myId) {
    body.assignees = [myId];
    fields.push("assignees");
  }
  if (fields.length) {
    actions.push({ type: "plane:update", workspaceSlug: ctx.repo.workspaceSlug, issueId: t.issueId, fields });
    if (!dryRun) await ctx.client.updateIssue(ctx.repo.workspaceSlug, ctx.projectId, t.issueId, body);
  }

  if (comment) {
    actions.push({ type: "plane:comment", issueId: t.issueId });
    if (!dryRun) {
      await ctx.client.createIssueComment(ctx.repo.workspaceSlug, ctx.projectId, t.issueId, { comment }, ctx.merged.apiPaths ?? {});
    }
  }

  return { ok: true, issueId: t.issueId, summary: summarizePlan(actions, { cwd: ctx.repoRoot }) };
}

async function cmdProbe({ repoPath }) {
  const start = repoPath ? path.resolve(repoPath) : process.cwd();
  const repoRoot = await findRepoRoot(start);
  const { merged, repo, globalPath, repoPath: rp } = await loadConfig(repoRoot ?? start);
  const client = new PlaneClient(merged);
  try {
    const me = await client.me();
    return { ok: true, config: { globalPath, repoPath: rp }, me };
  } catch (e) {
    return { ok: false, config: { globalPath, repoPath: rp }, error: String(e?.message ?? e) };
  }
}

async function cmdSyncLike({ repoPath, dryRun, mode }) {
  const ctx = await getCtx(repoPath);
  const planeIssuesRaw = await ctx.client.listIssues(ctx.repo.workspaceSlug, ctx.projectId);
  const planeIssuesList = Array.isArray(planeIssuesRaw) ? planeIssuesRaw : (planeIssuesRaw?.results ?? []);
  const issuesById = new Map();
  const issuesByTitle = new Map();
  for (const it of planeIssuesList) {
    if (it?.id) issuesById.set(String(it.id), it);
    if (it?.name) issuesByTitle.set(String(it.name).trim(), it);
  }

  const actions = [];
  const fileEdits = new Map();
  const nowIso = new Date().toISOString();

  for (const filePath of ctx.backlogFiles) {
    const md = await fs.readFile(filePath, "utf8");
    const parsed = parseMarkdownTasks(md, filePath);

    for (const task of parsed.tasks) {
      if (task.issueId) {
        const issue = issuesById.get(String(task.issueId));
        if (!issue) {
          actions.push({ type: "conflict", issueId: task.issueId, reason: "issueId present in markdown but not found in Plane" });
          continue;
        }

        const mdKey = `${filePath}:${task.lineIndex}`;
        const mdHash = sha256(`${task.checked ? "x" : " "}:${task.title}`);
        const prev = ctx.state.issues?.[String(task.issueId)] ?? null;
        const planeUpdatedAt = issue.updated_at ?? issue.updatedAt ?? null;

        const mdChangedSinceLast = prev ? prev.mdHash !== mdHash : true;
        const planeChangedSinceLast = prev ? prev.planeUpdatedAt !== planeUpdatedAt : true;

        if (prev && mdChangedSinceLast && planeChangedSinceLast) {
          actions.push({ type: "conflict", issueId: task.issueId, reason: "both markdown and Plane changed since last sync" });
          continue;
        }

        if (!prev || planeChangedSinceLast) {
          const planeTitle = String(issue.name ?? "").trim();
          if (planeTitle && planeTitle !== task.title) {
            const entry = fileEdits.get(filePath) ?? { lines: parsed.lines.slice(), changedCount: 0 };
            applyTaskLineUpdate(entry.lines, task, { title: planeTitle, issueId: String(issue.id) });
            entry.changedCount++;
            fileEdits.set(filePath, entry);
          }
        } else if (mdChangedSinceLast) {
          const fields = [];
          if (String(issue.name ?? "").trim() !== task.title) fields.push("name");
          if (fields.length) {
            actions.push({ type: "plane:update", workspaceSlug: ctx.repo.workspaceSlug, issueId: String(issue.id), fields });
            if (!dryRun && mode === "sync") {
              await ctx.client.updateIssue(ctx.repo.workspaceSlug, ctx.projectId, String(issue.id), { name: task.title });
            }
          }
        }

        ctx.state.issues[String(task.issueId)] = { lastSyncedAt: nowIso, mdHash, planeUpdatedAt, mdKey };
      } else {
        const existing = issuesByTitle.get(task.title);
        if (existing?.id) {
          const entry = fileEdits.get(filePath) ?? { lines: parsed.lines.slice(), changedCount: 0 };
          applyTaskLineUpdate(entry.lines, task, { issueId: String(existing.id) });
          entry.changedCount++;
          fileEdits.set(filePath, entry);

          ctx.state.issues[String(existing.id)] = {
            lastSyncedAt: nowIso,
            mdHash: sha256(`${task.checked ? "x" : " "}:${task.title}`),
            planeUpdatedAt: existing.updated_at ?? existing.updatedAt ?? null,
            mdKey: `${filePath}:${task.lineIndex}`,
          };
        } else {
          actions.push({ type: "plane:create", workspaceSlug: ctx.repo.workspaceSlug, projectId: ctx.projectId, title: task.title });
          if (!dryRun && mode === "sync") {
            const created = await ctx.client.createIssue(ctx.repo.workspaceSlug, ctx.projectId, { name: task.title });
            const createdId = String(created?.id);
            if (createdId) {
              const entry = fileEdits.get(filePath) ?? { lines: parsed.lines.slice(), changedCount: 0 };
              applyTaskLineUpdate(entry.lines, task, { issueId: createdId });
              entry.changedCount++;
              fileEdits.set(filePath, entry);
              ctx.state.issues[createdId] = {
                lastSyncedAt: nowIso,
                mdHash: sha256(`${task.checked ? "x" : " "}:${task.title}`),
                planeUpdatedAt: created.updated_at ?? created.updatedAt ?? null,
                mdKey: `${filePath}:${task.lineIndex}`,
              };
            }
          }
        }
      }
    }
  }

  for (const [filePath, e] of fileEdits.entries()) {
    actions.push({ type: "md:update", filePath, count: e.changedCount });
    if (!dryRun && mode === "sync") await fs.writeFile(filePath, e.lines.join("\n"), "utf8");
  }

  ctx.state.lastRunAt = nowIso;
  await writeState(ctx.repoRoot, ctx.state, { dryRun: dryRun || mode !== "sync" });
  return { ok: true, summary: summarizePlan(actions, { cwd: ctx.repoRoot }), actions };
}

const mcpServer = new McpServer({ name: "mcp-plane-sync", version: "0.1.0" });

mcpServer.registerTool(
  "plane_probe",
  {
    description: "Verify Plane API token and repository config (users/me).",
    inputSchema: { repoPath: z.string().optional() },
  },
  async ({ repoPath }) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdProbe({ repoPath }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_sync_status",
  {
    description: "Dry-run: show planned markdown ↔ Plane sync without writing files.",
    inputSchema: { repoPath: z.string().optional(), dryRun: z.boolean().optional() },
  },
  async ({ repoPath, dryRun }) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdSyncLike({ repoPath, dryRun: dryRun ?? true, mode: "status" }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_sync",
  {
    description: "Apply bidirectional sync between markdown backlog and Plane issues.",
    inputSchema: { repoPath: z.string().optional(), dryRun: z.boolean().optional() },
  },
  async ({ repoPath, dryRun }) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdSyncLike({ repoPath, dryRun: dryRun ?? false, mode: "sync" }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_issue_new",
  {
    description: "Create a Plane issue and append a task line to the markdown backlog.",
    inputSchema: {
      repoPath: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      toSection: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdNew({ ...args, dryRun: args.dryRun ?? false }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_issue_take",
  {
    description: "Move task to Doing (or section), assign self, optional comment.",
    inputSchema: {
      repoPath: z.string().optional(),
      query: z.string(),
      toSection: z.string().optional(),
      comment: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdTake({ ...args, dryRun: args.dryRun ?? false }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_issue_set_status",
  {
    description: "Move task to a markdown section and update Plane state when mapped.",
    inputSchema: {
      repoPath: z.string().optional(),
      query: z.string(),
      toSection: z.string(),
      dryRun: z.boolean().optional(),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdSetStatus({ ...args, dryRun: args.dryRun ?? false }), null, 2) }],
  }),
);

mcpServer.registerTool(
  "plane_issue_comment",
  {
    description: "Add a comment on a Plane issue (and details file if configured).",
    inputSchema: {
      repoPath: z.string().optional(),
      query: z.string(),
      text: z.string(),
      dryRun: z.boolean().optional(),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await cmdComment({ ...args, dryRun: args.dryRun ?? false }), null, 2) }],
  }),
);

async function run() {
  loadEnv();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

run().catch((e) => {
  process.stderr.write((e?.stack ?? e?.message ?? String(e)) + "\n");
  process.exit(1);
});

