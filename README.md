# plane-io-mcp — MCP server for Plane + markdown backlog

**plane-io-mcp** (npm package name: `mcp-plane-sync`) is a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) **stdio** server that connects **[Plane](https://plane.so/)** (open-source project management and issue tracking) with a **markdown backlog** inside a **Git** repository. Use it from **Cursor**, **Claude Desktop**, or any MCP-capable client to **sync issues**, **create tasks**, **move Kanban sections**, **comment**, and **probe** API auth — without leaving your editor.

If you searched for **Plane MCP**, **Plane.io MCP**, **Plane issue sync**, **markdown backlog Plane**, **Cursor Plane integration**, **PAT Plane API**, or **self-hosted Plane automation**, this tool is aimed at that workflow.

---

## Features

| Area | What it does |
|------|----------------|
| **Bidirectional sync** | Aligns Plane issues with `- [ ]` tasks in markdown files; stores `<!-- plane:issueId=... -->` markers |
| **Dry-run** | `plane_sync_status` plans changes without writing |
| **Workflow** | Create issues, take tasks (assign + move section), set status, add comments |
| **Config** | Per-repo `.plane-sync.json` + optional global `~/.config/plane-sync/config.json` |
| **Secrets** | `PLANE_TOKEN` / credentials file — never commit tokens |

### MCP tools (stdio)

- **`plane_probe`** — verify token and API (`/users/me`)
- **`plane_sync_status`** — dry-run sync plan
- **`plane_sync`** — apply sync (markdown ↔ Plane)
- **`plane_issue_new`** — create Plane issue + append backlog line
- **`plane_issue_take`** — move to Doing (or custom section), assign self, optional comment
- **`plane_issue_set_status`** — move markdown section + update Plane `state_id` when mapped
- **`plane_issue_comment`** — comment in Plane + optional details file update

All tools accept optional **`repoPath`**. If omitted, the server uses its **current working directory** and walks up to find `.git`.

---

## Requirements

- **Node.js** 18+
- A **Git** repo containing `.plane-sync.json` and markdown files matching `backlogFiles`
- **Plane** instance with API access (cloud or **self-hosted**)
- **Personal access token** (PAT) or API key with appropriate scopes

---

## Install

```bash
git clone git@github.com:iampelixm/plane-io-mcp.git
cd plane-io-mcp
npm install
```

---

## Configuration

### 1. Token (do not commit)

Copy the example env file and set your token:

```bash
cp .env.example .env
# edit .env — set PLANE_TOKEN=...
```

Alternatively use `~/.config/plane-sync/credentials.json` or global `config.json` (see below).

### 2. Global defaults (optional)

`~/.config/plane-sync/config.json` example:

```json
{
  "baseUrl": "https://your-plane.example.com",
  "apiBaseUrl": "https://your-plane.example.com/api/v1/",
  "auth": {
    "header": "Authorization",
    "scheme": "Bearer"
  }
}
```

Notes:

- Plane’s REST API is typically under **`/api/v1/`**. Trailing slashes on URLs matter on some deployments.
- API keys shaped like `plane_api_…` are sent as **`X-API-Key`** by default when no custom `auth` is set.

### 3. Repository config

In the **root of the Git project** (not necessarily this package), add `.plane-sync.json`. Start from the example in this repo:

```bash
cp .plane-sync.example.json /path/to/your/repo/.plane-sync.json
```

Edit `workspaceSlug`, `projectId` (or `projectSlug`), `backlogFiles`, and optional `mapping.sectionToStateId` so markdown headings map to Plane workflow **states**.

### State file

The sync writes **`.plane-sync.state.json`** in the repo for conflict detection. Add it to **`.gitignore`** in your application repository.

---

## Run (stdio)

From this package directory:

```bash
node src/index.mjs
```

Or after `npm link` / global install, run the **`mcp-plane-sync`** binary defined in `package.json`.

---

## Cursor / MCP client setup

Configure an MCP server with **command** `node` and **args** pointing to `src/index.mjs` (absolute path recommended). Set **cwd** to your **application repository** root so tools resolve `.plane-sync.json` and backlog files by default.

Example (conceptual — adjust paths):

```json
{
  "mcpServers": {
    "plane-sync": {
      "command": "node",
      "args": ["/absolute/path/to/plane-io-mcp/src/index.mjs"],
      "cwd": "/absolute/path/to/your/git/repo"
    }
  }
}
```

Ensure `PLANE_TOKEN` is available to that process (env file next to the server, shell profile, or client-specific env).

---

## How tasks link to Plane

Markdown checklist lines get an HTML comment marker:

```markdown
- [ ] Example task title <!-- plane:issueId=abc123 -->
```

The server parses headings as **sections** (Inbox / Ready / Doing / Done by default, configurable).

---

## Debugging

Set `PLANE_SYNC_DEBUG=1` to log sanitized request metadata to stderr (see `core.mjs`).

---

## Keywords / discovery (search)

Useful search terms for this project: **MCP**, **Model Context Protocol**, **stdio MCP server**, **Plane**, **Plane.so**, **Plane app**, **Plane REST API**, **issue sync**, **backlog sync**, **markdown tasks**, **Git workflow**, **Cursor MCP**, **AI coding assistant**, **project management API**, **Kanban**, **PAT**, **personal access token**, **self-hosted Plane**, **two-way sync**, **developer tooling**, **Node.js ESM**.

---

## License

See repository root if a `LICENSE` file is added; until then, usage is governed by your team’s policy for this fork.

---

## Related

- **Plane** — [plane.so](https://plane.so/)
- **MCP** — [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- **@modelcontextprotocol/sdk** — official MCP SDK for Node
