import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function ensureTrailingSlashUrl(u) {
  return u.endsWith("/") ? u : `${u}/`;
}

export function joinUrl(base, p) {
  const b = ensureTrailingSlashUrl(base);
  return new URL(p.replace(/^\//, ""), b).toString();
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(dir, ".git");
    if (await fileExists(gitPath)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readJsonIfExists(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

export function defaultCredentialsPath() {
  return path.join(os.homedir(), ".config", "plane-sync", "credentials.json");
}

async function loadCredentials() {
  const p = defaultCredentialsPath();
  const raw = await readJsonIfExists(p);
  return raw ?? {};
}

function deepMerge(base, override) {
  if (!override) return base;
  if (!base) return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== "object" || typeof override !== "object") return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

export function normalizeConfig(cfg) {
  const baseUrl = cfg?.baseUrl ?? "https://plane.summersite.ru";
  const apiBaseUrl =
    cfg?.apiBaseUrl ??
    joinUrl(baseUrl, "/api/v1/");

  // Accept legacy /api/ and normalize to /api/v1/ (Plane's PAT auth lives on v1 endpoints).
  const normalizedApiBaseUrl = (() => {
    const u = ensureTrailingSlashUrl(String(apiBaseUrl));
    return u.endsWith("/api/") ? u.replace(/\/api\/$/, "/api/v1/") : u;
  })();

  // token is resolved later (env > repo token > credentials by apiBaseUrl > global token)
  const token = process.env.PLANE_TOKEN ?? cfg?.token ?? null;

  const explicitAuth = cfg?.auth && (cfg?.auth?.header || cfg?.auth?.scheme);
  const looksLikeApiKey = typeof token === "string" && /^plane_api_/i.test(token);
  const auth = {
    header: cfg?.auth?.header ?? (explicitAuth ? "Authorization" : (looksLikeApiKey ? "X-API-Key" : "Authorization")),
    scheme: cfg?.auth?.scheme ?? (explicitAuth ? "Bearer" : (looksLikeApiKey ? "" : "Bearer")),
  };

  return {
    baseUrl,
    apiBaseUrl: normalizedApiBaseUrl,
    token,
    auth,
    defaults: cfg?.defaults ?? {},
    apiPaths: cfg?.apiPaths ?? {},
  };
}

export async function loadConfig(repoRoot) {
  const globalPath = path.join(os.homedir(), ".config", "plane-sync", "config.json");
  const repoPath = repoRoot ? path.join(repoRoot, ".plane-sync.json") : null;

  const globalCfg = normalizeConfig((await readJsonIfExists(globalPath)) ?? {});
  const repoCfgRaw = repoPath ? await readJsonIfExists(repoPath) : null;
  const mergedRaw = deepMerge(globalCfg, repoCfgRaw ?? {});
  let merged = normalizeConfig(mergedRaw);

  // Resolve token for a specific apiBaseUrl using credentials file.
  // Priority:
  // 1) PLANE_TOKEN env
  // 2) token in repo config (.plane-sync.json) if present
  // 3) ~/.config/plane-sync/credentials.json by apiBaseUrl
  // 4) token from global config
  if (!process.env.PLANE_TOKEN) {
    const repoToken = repoCfgRaw?.token ?? null;
    if (repoToken) {
      merged = { ...merged, token: repoToken };
    } else {
      const creds = await loadCredentials();
      const key = ensureTrailingSlashUrl(merged.apiBaseUrl);
      const c = creds?.[key] ?? creds?.[key.replace(/\/+$/, "")] ?? null;
      const credToken = c?.token ?? null;
      const credAuth = c?.auth ?? null;
      if (credToken) {
        merged = {
          ...merged,
          token: credToken,
          auth: credAuth ? { ...merged.auth, ...credAuth } : merged.auth,
        };
      } else {
        // keep global token (already in merged.token)
      }
    }
  }

  const repo = repoCfgRaw
    ? {
        ...repoCfgRaw,
        workspaceSlug: repoCfgRaw.workspaceSlug ?? merged.defaults.workspaceSlug ?? null,
        projectId: repoCfgRaw.projectId ?? null,
        projectSlug: repoCfgRaw.projectSlug ?? null,
        backlogFiles: repoCfgRaw.backlogFiles ?? [],
        mapping: repoCfgRaw.mapping ?? {},
        detailsFile: repoCfgRaw.detailsFile ?? null,
        sections: repoCfgRaw.sections ?? null,
      }
    : null;

  return { globalPath, repoPath, global: globalCfg, repo, merged };
}

function toRegExpFromGlob(glob) {
  const sep = "[/\\\\]";
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*\\\*/g, "§§DOUBLESTAR§§")
    .replace(/\\\*/g, "§§STAR§§")
    .replace(/\\\?/g, "§§Q§§");

  const re = escaped
    .replace(/§§DOUBLESTAR§§/g, `(?:.*)`)
    .replace(/§§STAR§§/g, `(?:[^/\\\\]*)`)
    .replace(/§§Q§§/g, `(?:[^/\\\\])`)
    .replace(/\//g, sep);

  return new RegExp(`^${re}$`);
}

async function walkFiles(rootDir) {
  const out = [];
  const skipNames = new Set(["node_modules", ".git", "dist", "coverage", ".cursor", ".dev", ".vite"]);
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skipNames.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

export async function resolveBacklogFiles(repoRoot, patterns) {
  const pats = (patterns ?? []).filter(Boolean);
  if (!pats.length) return [];
  const absPats = pats.map((p) => path.resolve(repoRoot, p));
  const hasGlob = absPats.some((p) => /[*?]/.test(p));
  if (!hasGlob) return absPats;

  const all = await walkFiles(repoRoot);
  const res = [];
  for (const pat of absPats) {
    const re = toRegExpFromGlob(pat);
    for (const f of all) if (re.test(f)) res.push(f);
  }
  return Array.from(new Set(res)).sort();
}

export const ISSUE_ID_RE = /<!--\s*plane:issueId=([a-zA-Z0-9_-]+)\s*-->/;

export function stripPlaneMarkers(s) {
  return s.replace(/<!--\s*plane:[^>]*-->\s*$/g, "").trimEnd();
}

export function upsertIssueIdMarker(line, issueId) {
  const trimmed = line.trimEnd();
  if (ISSUE_ID_RE.test(trimmed)) {
    return trimmed.replace(ISSUE_ID_RE, `<!-- plane:issueId=${issueId} -->`);
  }
  return `${trimmed} <!-- plane:issueId=${issueId} -->`;
}

export function parseMarkdownTasks(markdown, filePath) {
  const lines = markdown.split("\n");
  const tasks = [];
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, title });
      continue;
    }

    const m = /^(\s*[-*]\s+)\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const checked = m[2].toLowerCase() === "x";
    const rest = m[3];
    const issueId = (ISSUE_ID_RE.exec(rest)?.[1] ?? null);
    const title = stripPlaneMarkers(rest).trim();

    tasks.push({
      filePath,
      lineIndex: i,
      prefix: m[1],
      checked,
      title,
      issueId,
      headings: headings.map((x) => x.title),
      rawLine: line,
    });
  }

  return { lines, tasks };
}

export function applyTaskLineUpdate(lines, task, { title, checked, issueId }) {
  const newChecked = checked ?? task.checked;
  const box = newChecked ? "x" : " ";
  const newTitle = (title ?? task.title).trim();
  let line = `${task.prefix}[${box}] ${newTitle}`;
  const finalIssueId = issueId ?? task.issueId;
  if (finalIssueId) line = upsertIssueIdMarker(line, finalIssueId);
  lines[task.lineIndex] = line;
}

export async function readState(repoRoot) {
  const p = path.join(repoRoot, ".plane-sync.state.json");
  return (await readJsonIfExists(p)) ?? { issues: {}, lastRunAt: null };
}

export async function writeState(repoRoot, state, { dryRun }) {
  if (dryRun) return;
  const p = path.join(repoRoot, ".plane-sync.state.json");
  await fs.writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export class PlaneClient {
  constructor({ apiBaseUrl, token, auth }) {
    this.apiBaseUrl = ensureTrailingSlashUrl(apiBaseUrl);
    this.token = token;
    this.auth = auth;
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.token) {
      if (this.auth.header.toLowerCase() === "authorization") {
        const scheme = this.auth.scheme ? `${this.auth.scheme} ` : "";
        h[this.auth.header] = `${scheme}${this.token}`;
      } else {
        h[this.auth.header] = this.token;
      }
    }
    return h;
  }

  async request(method, p, { query, body } = {}) {
    const u = new URL(p.replace(/^\//, ""), this.apiBaseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        u.searchParams.set(k, String(v));
      }
    }
    if (!u.pathname.endsWith("/")) u.pathname += "/";

    const headers = this.headers();
    if (process.env.PLANE_SYNC_DEBUG === "1") {
      const safe = {};
      for (const [k, v] of Object.entries(headers)) {
        safe[k] = typeof v === "string" ? `${v.slice(0, 12)}… (len=${v.length})` : String(v);
      }
      // eslint-disable-next-line no-console
      console.error(`[plane-sync] ${method} ${u.toString()} headers=${JSON.stringify(safe)}`);
    }

    const res = await fetch(u.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = typeof data === "object" && data ? JSON.stringify(data) : String(data);
      throw new Error(`Plane API ${method} ${u.pathname} failed: ${res.status} ${res.statusText} ${msg}`);
    }
    return data;
  }

  me() {
    return this.request("GET", "/users/me");
  }
  listWorkspaces() {
    return this.request("GET", "/workspaces");
  }
  listProjects(workspaceSlug) {
    return this.request("GET", `/workspaces/${encodeURIComponent(workspaceSlug)}/projects`);
  }
  listIssues(workspaceSlug, projectId, { query } = {}) {
    if (!projectId) throw new Error("listIssues: projectId is required");
    return this.request("GET", `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues`, {
      query,
    });
  }
  createIssue(workspaceSlug, projectId, body) {
    if (!projectId) throw new Error("createIssue: projectId is required");
    const b = { ...(body ?? {}) };
    if (b.description && !b.description_html) {
      b.description_html = `<p>${String(b.description).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "</p><p>")}</p>`;
      delete b.description;
    }
    delete b.project_id;
    return this.request("POST", `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues`, { body: b });
  }
  updateIssue(workspaceSlug, projectId, issueId, body) {
    if (!projectId) throw new Error("updateIssue: projectId is required");
    return this.request(
      "PATCH",
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`,
      { body },
    );
  }
  async createIssueComment(workspaceSlug, projectId, issueId, body, apiPaths = {}) {
    if (!projectId) throw new Error("createIssueComment: projectId is required");
    const b = { ...(body ?? {}) };
    if (b.comment && !b.comment_html) {
      b.comment_html = `<p>${String(b.comment).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "</p><p>")}</p>`;
      delete b.comment;
    }
    const candidates = [];
    if (apiPaths?.createIssueComment) candidates.push(apiPaths.createIssueComment);
    candidates.push(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/comments`,
    );
    candidates.push(`/workspaces/${encodeURIComponent(workspaceSlug)}/issues/${encodeURIComponent(issueId)}/comments`);
    candidates.push(`/workspaces/${encodeURIComponent(workspaceSlug)}/issues/${encodeURIComponent(issueId)}/comments/create`);
    let lastErr = null;
    for (const p of candidates) {
      try {
        return await this.request("POST", p, { body: b });
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        if (!msg.includes(" 404 ")) break;
      }
    }
    throw lastErr ?? new Error("Failed to create comment (no candidate endpoints succeeded)");
  }
}

export function assertRepoConfig(repoCfg) {
  if (!repoCfg) throw new Error("Repo config .plane-sync.json not found.");
  if (!repoCfg.workspaceSlug) throw new Error("Missing repo config field: workspaceSlug");
  if (!repoCfg.projectId && !repoCfg.projectSlug) throw new Error("Missing repo config field: projectId or projectSlug");
  if (!repoCfg.backlogFiles || !Array.isArray(repoCfg.backlogFiles) || repoCfg.backlogFiles.length === 0) {
    throw new Error("Missing repo config field: backlogFiles (non-empty array)");
  }
}

export function pickProjectId(projects, repoCfg) {
  if (repoCfg.projectId) return repoCfg.projectId;
  if (!repoCfg.projectSlug) return null;
  const p = projects.find((x) => x.slug === repoCfg.projectSlug) ?? projects.find((x) => x.identifier === repoCfg.projectSlug);
  return p?.id ?? null;
}

export function defaultSections() {
  return { inbox: "Inbox", ready: "Ready", doing: "Doing", done: "Done" };
}

export function normalizeSections(repo) {
  const d = defaultSections();
  const s = repo?.sections ?? {};
  return { inbox: s.inbox ?? d.inbox, ready: s.ready ?? d.ready, doing: s.doing ?? d.doing, done: s.done ?? d.done };
}

export function sectionToPlaneStateId(repo, sectionName) {
  const map = repo?.mapping?.sectionToStateId ?? repo?.mapping?.sectionToState ?? null;
  if (!map || typeof map !== "object") return null;
  return map[sectionName] ?? null;
}

export function summarizePlan(actions, { cwd } = {}) {
  const base = cwd ?? process.cwd();
  const lines = [];
  for (const a of actions) {
    if (a.type === "md:update") lines.push(`MD ${path.relative(base, a.filePath)}: update ${a.count} line(s)`);
    else if (a.type === "plane:create") lines.push(`Plane: create issue for "${a.title}" in ${a.workspaceSlug} (projectId=${a.projectId})`);
    else if (a.type === "plane:update") lines.push(`Plane: update issue ${a.issueId} (${a.fields.join(", ")})`);
    else if (a.type === "conflict") lines.push(`CONFLICT issue ${a.issueId}: ${a.reason}`);
    else if (a.type === "md:move") lines.push(`MD ${path.relative(base, a.filePath)}: move "${a.title}" -> ${a.toSection}`);
    else if (a.type === "md:append") lines.push(`MD ${path.relative(base, a.filePath)}: append "${a.title}" to ${a.toSection}`);
    else if (a.type === "md:details") lines.push(`MD ${path.relative(base, a.filePath)}: update details for issue ${a.issueId}`);
    else if (a.type === "plane:comment") lines.push(`Plane: comment on issue ${a.issueId}`);
  }
  return lines.join("\n");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findHeadingLineIndex(lines, headingText) {
  const re = new RegExp(`^(#{1,6})\\s+${escapeRegExp(headingText)}\\s*$`);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
  return null;
}

function findSectionRange(lines, headingIndex) {
  if (headingIndex === null) return null;
  const m = /^(#{1,6})\s+/.exec(lines[headingIndex]);
  const level = m ? m[1].length : 2;
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s+/.exec(lines[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start: headingIndex, bodyStart: headingIndex + 1, end };
}

export function moveTaskLineBetweenSections(lines, taskLineIndex, toHeadingText) {
  const line = lines[taskLineIndex];
  lines.splice(taskLineIndex, 1);
  const toIdx = findHeadingLineIndex(lines, toHeadingText);
  if (toIdx === null) throw new Error(`Target section heading not found: ${toHeadingText}`);
  const range = findSectionRange(lines, toIdx);
  let insertAt = range.end;
  while (insertAt > range.bodyStart && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
}

export function appendTaskLineToSection(lines, toHeadingText, taskLine) {
  const toIdx = findHeadingLineIndex(lines, toHeadingText);
  if (toIdx === null) throw new Error(`Target section heading not found: ${toHeadingText}`);
  const range = findSectionRange(lines, toIdx);
  let insertAt = range.end;
  while (insertAt > range.bodyStart && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, taskLine);
}

export function findTaskMatches(tasks, query) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const looksId = /^[a-zA-Z0-9_-]{2,}$/.test(q);
  const byId = looksId ? tasks.filter((t) => t.issueId === q) : [];
  if (byId.length) return byId;
  const lower = q.toLowerCase();
  return tasks.filter((t) => (t.title ?? "").toLowerCase().includes(lower));
}

export async function ensureDetailsEntry({ repoRoot, repoCfg, issueId, title, description, dryRun, actions }) {
  if (!repoCfg.detailsFile) return;
  const detailsPath = path.resolve(repoRoot, repoCfg.detailsFile);
  let content = "";
  try {
    content = await fs.readFile(detailsPath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    content = `# Task details\n\n`;
  }
  const lines = content.split("\n");
  const marker = `<!-- plane:issueId=${issueId} -->`;
  let idx = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      idx = i;
      break;
    }
  }

  const block = [];
  block.push(`### ${title} ${marker}`);
  block.push("");
  if (description) {
    block.push(description.trimEnd());
    block.push("");
  }
  block.push(`_Last updated: ${new Date().toISOString()}_`);
  block.push("");

  if (idx === null) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(...block);
  } else {
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^###\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(idx, end - idx, ...block);
  }

  actions.push({ type: "md:details", filePath: detailsPath, issueId });
  if (!dryRun) await fs.writeFile(detailsPath, lines.join("\n"), "utf8");
}

