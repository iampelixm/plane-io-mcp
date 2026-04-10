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

### Guided install for Cursor (interactive)

The repository includes **`install-cursor-mcp.sh`** (Russian prompts). It will:

- Ask for your **Git project root**, **Plane API token**, **API base URL**, **workspace slug**, **project id** (or **project slug** if id is empty), and **backlog file path** (default `docs/todo/backlog.md`).
- Write **`~/.config/plane-mcp.env`** (`PLANE_TOKEN`, mode `600`) and merge **`~/.config/plane-sync/config.json`** (`baseUrl` / `apiBaseUrl`, no token).
- Create or update **`.plane-sync.json`** in the project, create the backlog file with default **Inbox / Ready / Doing / Done** headings if missing, and append **`.plane-sync.state.json`** and **`.env`** to the project **`.gitignore`**.
- Merge the **`plane-sync`** entry into **`~/.cursor/mcp.json`** using the **absolute path to this clone** (`src/index.mjs`), **`cwd`: `${workspaceFolder}`**, and **`envFile`** pointing at `~/.config/plane-mcp.env`.
- Optionally run **`npm install`** in the clone.

```bash
chmod +x install-cursor-mcp.sh
./install-cursor-mcp.sh
```

After it finishes, **restart Cursor** (or toggle MCP) and run **`plane_probe`** from a chat with the target workspace open.

**NVM-only machines:** if `node` is not on `PATH` yet, the script tries to `source` `$NVM_DIR/nvm.sh` (default `~/.nvm/nvm.sh`), then falls back to the newest directory under `~/.nvm/versions/node/*/bin/node`. The generated **`mcp.json` always stores the absolute path to `node`**, because Cursor’s MCP process usually does **not** load NVM.

---

## Configuration

### 1. Token (do not commit)

The server reads **`.env`** in this order (standard `dotenv` rules: an already-set variable is not overwritten by a later file):

1. **`<current working directory>/.env`** — whatever directory the MCP process was started with as `cwd`.  
   - In Cursor, if you set `"cwd": "${workspaceFolder}"`, this is the **root of the open project**. Put **`PLANE_TOKEN`** there if the token should be **per repository**.
2. **`<plane-io-mcp clone>/.env`** — next to this package’s `package.json` (parent of `src/`).  
   - Use this for a **single shared token** on the machine, or when you run `node src/index.mjs` from inside the clone.

You can keep **only one** of these files, or both (workspace `.env` wins for keys present in both).

Example next to the clone:

```bash
cd /path/to/plane-io-mcp
cp .env.example .env
# edit .env — set PLANE_TOKEN=...
```

Example for a **per-project** token: create `.env` in the **app repo root** (and add `.env` to that repo’s `.gitignore`).

You do **not** have to use `.env` at all if the token is already in the environment (e.g. `env` / `envFile` in the MCP client config) or in **`~/.config/plane-sync/credentials.json`** / global `config.json` (see below).

### 2. Global defaults (optional)

`~/.config/plane-sync/config.json` example:

```json
{
  "baseUrl": "https://your-plane.example.com",
  "apiBaseUrl": "https://your-plane.example.com/api/v1/"
}
```

Notes:

- Plane’s REST API is typically under **`/api/v1/`**. Trailing slashes on URLs matter on some deployments.
- For tokens shaped like **`plane_api_…`**, Plane expects the **`X-API-Key`** header — **not** `Authorization: Bearer …`.
- If this file defines an **`auth`** block that forces **Bearer** (or any scheme other than the key header), it **overrides** the automatic API-key behaviour. Requests then go out with the wrong header and the API often returns **401** (*Authentication credentials were not provided*). **Either** omit `auth` for `plane_api_…` keys, **or** document clearly that Bearer must not be forced for those keys.

### 3. Repository config (`.plane-sync.json`)

In the **root of the Git project** (not necessarily this package), add `.plane-sync.json`. Start from the example in this repo:

```bash
cp .plane-sync.example.json /path/to/your/repo/.plane-sync.json
```

Edit `workspaceSlug`, **`projectId`** (recommended) or **`projectSlug`**, `backlogFiles`, and optional `mapping.sectionToStateId` so markdown headings map to Plane workflow **states**.

**`projectId` must be the project UUID** from Plane’s API (e.g. from the projects list). Issue URLs use `…/projects/{id}/issues/…` with that **UUID**. A short **human-readable identifier** (e.g. `GOVADMIN`) is **not** the same value — putting it in `projectId` leads to **404** on issue routes. You may set **`projectSlug`** instead of **`projectId`**; the server resolves it via **`listProjects`** (see *Integrator notes*).

**Optional — Kanban / status sync:** if **`mapping.sectionToStateId`** is empty or wrong, markdown sections and Plane columns may diverge. For full Kanban ↔ Plane alignment, fill the map using **state ids** from your workspace’s workflow in Plane (API or UI), keyed by the **exact** section heading strings you use in markdown.

### State file

The sync writes **`.plane-sync.state.json`** in the repo for conflict detection. Add it to **`.gitignore`** in your application repository.

### Integrator notes (package / MCP consumers)

- **`listProjects` response shape:** Plane often returns a **paginated object** (`results`, `total_count`, …), not a bare array. **`pickProjectId`** in `core.mjs` accepts both an array and **`{ results }`** so **`projectSlug`** resolution works. If you fork the client, normalize the same way before calling **`.find`** on the list.

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

## Issue summary (for tickets / handoff)

- **401** with API key: global **`~/.config/plane-sync/config.json`** forces **Bearer** via **`auth`**, so **`X-API-Key`** is not used.
- **404** on issues: **`projectId`** must be the **UUID**, not a short **identifier** (e.g. `GOVADMIN`).
- **Crash** with **`projectSlug`** only (older builds): paginated **`listProjects`** + **`pickProjectId`** calling **`.find`** on the raw object — fixed in this repo by normalizing to **`results`** inside **`pickProjectId`**.

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
