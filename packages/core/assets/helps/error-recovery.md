# Error recovery — when a tool call fails, or the user says something is broken

This is the lookup the agent reads BEFORE asking the user a clarifying
question or giving up on a failing tool call. Each section is keyed by
the error message you'd see in tool output, with the cause and the
documented fix.

It has a second entry point. When the **user** reports that MulmoClaude is
broken / weird / not working — nothing has failed in tool output, they are
just describing a symptom — start at **§ The user says MulmoClaude is
broken** below instead of scanning the error-keyed sections.

Cite the section you used in your reply so the user can follow up
(e.g. "Per `config/helps/error-recovery.md` § gh-auth / SSH …").

If no section here matches, list the workspace's other help files
(`ls config/helps/`) and Read whichever name best matches the failing
area (`sandbox.md`, `github.md`, `collection-skills.md`, etc.) before
falling back to asking the user.

## The user says MulmoClaude is broken

**The goal is that the user ends up unblocked, not that an issue gets filed.**
An issue is what's left after the first three steps fail to explain the
behaviour. Work them in order and stop the moment the user is unblocked.

Rules that hold in every step:

- **Never assert "that's by design" from memory.** Say it only with a reason
  attached: a config key, a help page, an implementation file.
  `bug-report-faq.md` is an index of where to look — it deliberately contains
  no values.
- **Read the real thing.** Current values come from the workspace's
  `config/settings.json` or `GET /api/health`, never from recollection.
- **"I don't know" is an allowed answer.** If a step can't decide, say so and
  go to the next one. Never close the conversation by guessing.
- **Nothing leaves the machine before the user has seen it in full** and agreed.
- Reply in the language the user writes in.

### Step 1 — Hear the symptom (collect nothing yet)

Call `presentForm` once with the questions below rather than asking in prose —
a user who is already frustrated should be clicking, not composing.

- **What kind** — display looks wrong / input doesn't work / the agent won't
  answer / a tool keeps failing / phone or remote features / something else
- **Where** — chat / a collection / the wiki / files / settings / the phone app
- **How often** — every time / sometimes / once
- **Since when** — after an update / it always did this / not sure
- **What did you expect, and what happened instead?** (free text, required —
  these two sentences are what the next step is judged against)

### Step 2 — Is it configuration, or by design? (this is the actual job)

1. Read `config/helps/bug-report-faq.md` and find the entry closest to the
   symptom.
2. Follow its pointers to the **real values** — `config/settings.json` for a
   `configKey`, the named help page for a `help`. A setting absent from the file
   is at its default, which is the answer to most entries there.
3. If that explains the gap between expected and actual, **say why, show the
   fix, and stop.** Cite what you checked.
4. If nothing explains it, go to Step 3. Do not stretch a FAQ entry to cover a
   symptom it doesn't cover.

### Step 3 — Is it already known?

Search the existing issues before opening anything:

```bash
gh issue list --repo receptron/mulmoclaude --state all --limit 20 --search "<symptom keywords>"
```

`gh` is **not available by default** — the agent runs in a credential-free
sandbox (see § gh / git / SSH errors inside the sandbox). Don't spend turns
fighting it: hand the user the search URL instead.

`https://github.com/receptron/mulmoclaude/issues?q=voice+input+disabled` — build
the `q=` value percent-encoded (space → `+` or `%20`, `#` → `%23`), or the link
breaks on the first symptom that contains one.

- **Closed and fixed** → compare their version against the release that fixed
  it. If they're simply behind, tell them to update and stop.
- **Open** → do not open a second one. Offer to add this user's environment and
  repro steps as a comment; a second reproduction is worth more than a duplicate.
- **Nothing found** → Step 4.

### Step 4 — File it

Only now collect details. Fetch the environment report from the server, from the
workspace root:

```bash
curl -s -H "Authorization: Bearer $(cat .session-token)" \
  "http://${MULMOCLAUDE_HOST:-127.0.0.1}:$(cat .server-port)/api/diagnostics/report"
```

Three parts of that command are load-bearing, and dropping any one returns
nothing useful:

- **The bearer header.** Every `/api/*` route requires it; without it the reply
  is a 401, not a report. The token is regenerated each startup and lives in
  `.session-token` at the workspace root.
- **`$MULMOCLAUDE_HOST`.** In the default Docker sandbox `localhost` is the
  container, not the machine running the server — the variable is set to
  `host.docker.internal` there and unset on a host-mode run, hence the fallback.
- **`.server-port`.** The port is chosen at startup; there is no fixed default
  to hardcode.

Keep the token inside the command substitution: never echo it, never let it
reach the report body, and if you quote the command in the issue, quote it in
the `$(cat …)` form above rather than with the value expanded.

**The server does the redaction, not you.** It prints values only for
allow-listed settings and withholds everything else, including the plaintext
Google Maps key and every MCP server's `env` / `headers`. Paste what it returns
verbatim — do not "help" by adding values you read elsewhere, and do not
re-type a secret you happened to see in a file.

Ask the user for what the host cannot see: the browser and its version, any red
errors in the browser console, and a screenshot if the symptom is visual. Say
before they attach one that a screenshot can carry file paths and chat text.

Report body:

```markdown
## What happened
## What I expected
## Steps to reproduce
1.
## Environment
(paste the diagnostics report here)
## Attachments
```

Show the whole thing, get an explicit yes, then post it — `gh issue create
--repo receptron/mulmoclaude --title "<title>" --body-file <file>` when `gh`
works, otherwise print the markdown for copy-paste plus
`https://github.com/receptron/mulmoclaude/issues/new`.

### When Step 2 resolved it

A question that took an agent to answer is a signal about the product: the UI
failed to say something. Offer to post it as an issue titled with the question
as the user asked it, noting what the answer turned out to be and **where it was
checked**. Open the body with a line saying the answer came from this lookup and
is awaiting maintainer review — it is a draft, not documentation. Never edit
`bug-report-faq.md` yourself.

## gh / git / SSH errors inside the sandbox

### Symptoms

- `gh: To authenticate, please run gh auth login`
- `git@github.com: Permission denied (publickey)`
- `Could not resolve host: github.com`
- `Permission denied (publickey)` on `git push` / `git clone <ssh-url>`
- `fatal: Could not read from remote repository`

### Cause

The Claude Code agent runs inside a credential-free Docker sandbox by
default. The host's SSH agent and `gh` config aren't exposed unless the
user opts them in.

### Fix

Tell the user to enable the two opt-in mounts on the next agent spawn
(see also `config/helps/sandbox.md` for the full contract):

```bash
# Forward the host's SSH agent into the container.
# Private keys stay on the host; only the signing oracle is exposed.
SANDBOX_FORWARD_SSH_AGENT=1 \
# Mount allowlisted config files/dirs read-only — including ~/.config/gh.
SANDBOX_MOUNT_CONFIGS=gh \
  yarn dev   # or: npx mulmoclaude
```

Equivalent CLI flags: `--sandbox-forward-ssh-agent --sandbox-mount-configs=gh`.

After restart, inside the agent's first tool turn verify:

```bash
ssh-add -l                      # should list at least one key
gh auth status                  # should report logged in
```

If `ssh-add -l` fails, the host's SSH agent isn't running — tell the
user to start it (`ssh-add ~/.ssh/id_*` on macOS / Linux). If
`gh auth status` fails, the user needs to run `gh auth login` on the
host first (host config is mounted read-only into the sandbox).

### When neither helps

The sandbox itself can be turned off for the session with
`DISABLE_SANDBOX=1 yarn dev` / `--disable-sandbox`. The agent then
inherits the user's full environment. Recommend this only when the
credential mount approach didn't resolve the issue — the sandbox is
the safer default.

## Collection registry — Contribute / Discover failures

### Symptoms

- Contribute flow: `gh pr create` fails, `git push` rejected, or the
  registry clone fails inside `github/`.
- Discover tab loads no entries, or one registry's cards are missing.

### Cause + fix

For the Contribute side, the underlying issue is almost always
sandbox credentials — see the gh/git/SSH section above before anything
else.

For Discover, multi-registry config lives at
`config/collections-registries.json`. A malformed entry there is
silently dropped; check the server log for
`[collections-registry] registry config entry rejected`. The file
format and validation rules are documented in
`config/helps/collection-skills.md` (Contribute bundle layout) and the
shipped registry repo's README. Common rejections:

- URL not HTTPS, or includes embedded credentials.
- `rawBaseUrl` contains a `?` query or `#` fragment.
- `name` reuses the reserved value `official`.
- `name` doesn't match `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`.

## A hand-placed custom role never appears in the list

### Symptoms

- The user put a file in `config/roles/` themselves (not via Settings →
  Roles / `manageRoles`) and the role is absent from the role list.
- Nothing failed in tool output — `manageRoles` with `action: "list"`
  simply doesn't include it.

### Cause + fix

The loader reads **`config/roles/<id>.json` only**, and a file it cannot
use is skipped rather than fatal — so one broken file can't take the
whole list down. The reason is in the server log as a `[roles]` warning
naming the file:

- `role file is not valid JSON, skipping` — trailing comma, single
  quotes, unquoted key.
- `role file does not match the role schema, skipping` — the `issues`
  field names each field, e.g. `icon: Invalid input: expected string,
  received undefined`. All of `id`, `name`, `icon`, `prompt`,
  `availablePlugins` are required; `availablePlugins` must be an array
  even for one entry.
- `role file is empty, skipping` — zero-length or whitespace only.
- `role file could not be read, skipping` — permissions, or the path is
  a directory.
- `role file disappeared while loading, skipping` — the file was renamed
  or deleted while the list was being read, or it is a broken symlink.
  Re-running the load is enough if the file is there now.
- `ignoring entries that are not .json files` — a `.md` / `.jsonc` /
  `.json.txt` file is never read as a role.

Ask the user for that warning line (or the file's contents) rather than
guessing which of the six it is. Writing the role through
`manageRoles` instead sidesteps all of them — it serializes the role, so
the file is always valid.

## A custom role is in the list but delete / update says it doesn't exist

### Symptoms

- `manageRoles` with `action: "list"` includes the role, but `delete` or
  `update` on that same id returns `Role '<id>' not found.`
- Or: `Cannot delete built-in roles.` for a role the user created.
- Or: the user edited a role and the change had no effect, because
  another file with the same id is the one that id resolves to.

### Cause + fix

The list shows the `id` from **inside** the file, while delete / update
address the role by its **file name** — so `config/roles/designer.json`
containing `"id": "myrole"` is listed as `myrole` but delete / update
only accept `designer`. Two `[roles]` warnings in the server log name
it:

- `role id does not match its file name` — `fileName` and `id` are both in
  the warning. Which repair is safe depends on which side is malformed:
  role ids must match `[a-zA-Z0-9_-]+`, and nothing enforces that on a
  hand-placed file. **Follow the variant the warning gives you** rather
  than picking a repair yourself — the wrong one can leave the role
  reachable under no name at all:
  - no extra clause — both names are usable. Rename the file to
    `<id>.json`, or change the `id` to the file's own name. Until then the
    **file name** is a working handle: `delete <file name>` removes it.
  - `… the file name is not a usable role id either` — e.g.
    `my role.json`, rejected as `Invalid role id 'my role'.` Neither name
    reaches the role. Renaming is the only fix.
  - `… the id is not a usable role id` — the reverse, e.g. `"id": "my
    role"` in `designer.json`. `delete designer` still works, and renaming
    to `my role.json` would take that away. Change the `id`.
  - `… neither is a usable role id` — pick one id that matches the pattern
    and use it for the file name and the `id` together.
  - an inner `id` equal to a built-in role's id — the file also shadows
    that built-in, and `delete` on the listed id refuses it as built-in.
    Renaming is the way out.
- `more than one role file declares the same id` — both files load and
  both appear in the list; `used` is the one that id resolves to
  (readdir order, not a choice the user made) and `ignored` lists the
  rest. Give each role a distinct id, or remove the extra file.

Ask the user for the warning line rather than guessing which of the two
it is. Both only happen to hand-placed or hand-renamed files:
`manageRoles` writes `config/roles/<role.id>.json`, so file name and
`id` always agree.

## Marp slide PDF — empty / image / font issues

### Symptoms

- PDF export of a Marp deck produces tofu (□□□) for Japanese / CJK text.
- Inline images in a slide are missing from the PDF.
- A custom Marp `theme: <name>` is ignored.

### Fix

CJK fonts (Hiragino on macOS, Yu Gothic / Meiryo on Windows, Noto Sans
CJK on Linux) need to exist on the **host running the server**, not
in the sandbox (PDF render happens server-side via puppeteer). On
Linux: `sudo apt-get install fonts-noto-cjk`. Docker host:
`apt-get install -y fonts-noto-cjk` in the production Dockerfile.

Inline images missing from the PDF: paths must be relative to the
`.md` file, NOT absolute or workspace-rooted. See the "Image
references in markdown / HTML" section of the system prompt for the
rule.

Custom theme ignored: themes live in `~/mulmoclaude/config/marp-themes/<name>.css`.
The filename (sans `.css`) is the theme slug; only `[A-Za-z0-9_-]` is
allowed. Reload the browser tab after adding a theme — preview caches
per session.

## MulmoScript render — "generate error" from image / movie / audio generation

### Symptoms

- A beat render, character image, movie, or PDF generation fails with a
  message like `generateReferenceImage: generate error: key=<name>` or
  `Image was not generated`.
- `autoGenerateMovie` leaves a `<script>.json.error.txt` sidecar next to
  the story file with a similar message.

### Cause

Generation providers are chosen **per script**: `imageParams.provider`,
`movieParams.provider`, and `speechParams.speakers.<name>.provider`. The
underlying failure is usually a missing/invalid API key for whichever
provider the script names (`openai` → `OPENAI_API_KEY`, `google` /
`gemini` → `GEMINI_API_KEY`, `replicate` → `REPLICATE_API_TOKEN`), or a
quota / moderation rejection from that provider.

### Fix

The server appends the provider's own error to the message (e.g.
`… — 401 Incorrect API key provided`) and logs it under the
`mulmocast` prefix — read that detail first. Then either add the
missing key to `.env` (restart the server) or rewrite the script's
`imageParams` / `movieParams` / speaker providers to ones that have
keys configured. Don't retry the render unchanged — the same provider
will fail the same way.

## Build / yarn workspace ordering

### Symptoms

- `yarn dev` fails on a fresh clone with
  `Cannot find module '@mulmoclaude/<x>-plugin/server'` or similar.
- A workspace package's `dist/` is missing on first run.

### Fix

```bash
yarn build:packages   # builds every shared workspace package in tier order
yarn dev              # then the dev server picks them up
```

If a specific package keeps failing, build just it:
`yarn workspace @mulmoclaude/<name> run build`. The build pipeline
runs plugins before services so cross-package imports resolve cold.

## Every reply takes 60-90 s, even a two-word one

### Symptoms

- Response time is roughly the same whether the user typed "hi" or a long
  paragraph — it does not scale with the message.
- The server log shows a large `durationMs=` on `[agent] request completed`
  while the model's actual answer is short.
- The first turn of a chat is slow and so is every turn after it.

### Cause

The `claude` CLI starts every MCP server the host has configured before it can
answer. That includes the user's own global servers in `~/.claude.json` and any
claude.ai connectors — MulmoClaude deliberately does not pass
`--strict-mcp-config` (see `server/agent/config.ts`), so those all load. A
server that is unreachable burns the full connect timeout (30 s each) before
the turn can start.

### Confirm it

`claude mcp list` connects to every configured server and reports each one's
status, so it measures exactly this cost with no inference involved:

```bash
cd ~/mulmoclaude && time claude mcp list
```

If that number is close to the per-turn `durationMs`, MCP startup is the cost,
not the model. Any line reading `Failed to connect` / `connection timed out
after 30000ms` is 30 s the user pays.

### Fix

1. Remove servers that cannot connect — each timeout is 30 s of dead wait:
   `claude mcp remove <name> --scope user`. Common dead entries are hosts that
   are no longer reachable and HTTP servers superseded by an `mcp-remote`
   stdio proxy.
2. Expect only the FIRST turn of a chat to pay this. MulmoClaude keeps the CLI
   process alive between turns (`server/agent/backend/claudeSession.ts`), so
   follow-up turns skip MCP startup entirely. `[agent] claude session acquired
   reused=true` in the log confirms the warm path.
3. If EVERY turn logs `reused=false`, the session is being respawned. The
   fingerprint covers the system prompt and CLI args, so something is changing
   between turns — a role switch, a plugin toggle, or a memory write. Run with
   `--debug` to dump the system prompt and compare.

Note that trimming one or two servers may just move the timeouts onto others:
a host that cannot cold-start its whole MCP fleet within the 30 s window will
show a different set of servers timing out each run. That is a signal to cut
the fleet down, not to chase individual entries.

## Plugin runtime — install / drift

### Symptoms

- A runtime plugin shown in `/skills` doesn't load, or its routes 404.
- After upgrading the plugin host, a previously-installed plugin
  reports a peer-dependency mismatch (e.g. `gui-chat-protocol`
  version skew).

### Fix

Runtime plugins are installed via tgz under `~/mulmoclaude/plugins/`
with a ledger at `plugins/plugins.json`. Reinstall the failing
plugin via the `/skills` UI to refresh both the tgz and the ledger.
A version skew on a peer dep means the plugin was built against an
older host — bump the plugin via the Discover tab's update flow.

## dataSource (CSV) collection reads fail — "DuckDB is unavailable on this host"

A collection whose schema declares `dataSource` (external CSV) reads its rows
through `@duckdb/node-api`, a NATIVE module with per-platform prebuilt
bindings. When the binding is missing or fails to load, ONLY dataSource
collections break (every file-backed collection keeps working) and reads
fail with `DuckDB is unavailable on this host (@duckdb/node-api failed to
load: …)`.

Diagnosis + fixes, in order:

1. **Reinstall dependencies** — `yarn install` at the app root. The usual
   cause is an install that skipped the platform package
   (`@duckdb/node-bindings-<platform>-<arch>`), e.g. after copying
   `node_modules` between machines or architectures (an arm64 → x64 Docker
   volume mount does exactly this).
2. **Check the platform is supported** — `ls node_modules/@duckdb/ | cat`.
   You should see a `node-bindings-<your platform>` package. If DuckDB ships
   no prebuilt binding for the host (rare: musl/alpine, exotic arch), there
   is no local fix — tell the user dataSource collections need a supported
   platform (glibc Linux x64/arm64, macOS, Windows) and that their other
   collections are unaffected.
3. **Docker**: make sure the image installs dependencies INSIDE the
   container (matching libc/arch) rather than bind-mounting a host
   `node_modules`.

Related, not an error: a dataSource CSV in Shift_JIS / UTF-16 is decoded
automatically to a cache copy under the OS temp dir — never "fix" the
user's file by re-encoding it.

## storage (sqlite) collection fails — "sqlite storage needs the node:sqlite module"

A collection whose schema declares `storage: { type: "sqlite", path: … }`
keeps its records in a single SQLite database file, read/written through
Node's BUILT-IN `node:sqlite` module — no npm dependency. That module
exists only in **Node.js >= 22.5**, while the app itself runs on >= 20.12,
so on an older runtime ONLY sqlite-backed collections break (file and
dataSource collections keep working) and every operation fails with
`sqlite storage needs the node:sqlite module (Node.js >= 22.5) — this
runtime cannot load it`.

Diagnosis + fixes, in order:

1. **Check the Node version** — `node --version`. Below 22.5 there is no
   local fix except upgrading Node; tell the user which version they run
   and that their other collections are unaffected.
2. **`ExperimentalWarning: SQLite is an experimental feature`** printed
   once on first use is EXPECTED on Node 22.x — it is a warning, not an
   error; do not chase it.
3. **Do not "repair" by converting the collection to `dataPath`** unless
   the user asks — the records live inside the `.db` file, not as
   `<id>.json` files; a schema flip alone would make the collection look
   empty, not migrate it.

Known limits of sqlite storage (by design, not bugs to fix in place):
a db row so corrupt the backend can't parse it is skipped silently (the
Repair pass reports schema violations by record id, but has no
"malformed file" classification), and the completion/spawn watcher
reconciles the WHOLE collection per db change (no per-record events).

## A record the user edited came back with the source's value

### Symptoms

Nothing fails — the user reports it. Any of:

- A Google Calendar collection record they edited shows Google's value
  again after a sync.
- A feed record lost the column they had added beside it, or the whole
  record disappeared once the item aged past `ingest.maxItems`.
- The edit is simply gone, and no conflict was ever reported.

### Cause

Records are written WHOLE (`writeItem`), so anything that mirrors a
remote source into a collection has to lay its values OVER the stored
record rather than replace it — and has to refuse when the record holds
an edit the source has not seen. Four separate places got that wrong:

- `#2683` — a calendar collection without `autoPush` was never in the
  pull's protected set at all.
- `#2684` — the protected set was a snapshot taken when the push
  finished, so an edit made while the window was in flight (minutes of
  it, on a full re-walk) was invisible to it.
- `#2688` — a cancellation in Google deleted the record without asking
  whether it held an unsent edit.
- `#2696` — the feeds ingest replaced the record whole, and the
  `maxItems` prune deleted annotated records once they aged out.

### Fix

All four are fixed as of `@mulmoclaude/core` 1.13.0. **Check the host's
version first** — if it is older, that is the whole answer.

If it happens on 1.13.0 or later, it is a new bug, not one of these:
capture which collection, whether it declares `googleCalendar` or
`ingest`, and what the record looked like before and after. Do NOT
suggest re-editing and hoping — the point of these fixes is that the
loss is no longer silent.

## A calendar conflict is reported on every Push and will not clear

### Symptoms

Push reports a conflict for a record that already matches Google. It
comes back on every attempt; nothing the user does in the record clears
it.

### Cause

The conflict check compares Google against the BASELINE in
`<workspace>/data/calendar/.push-state.json`, not against the record.
A baseline older than both sides reports a conflict forever.

Before `#2679` that happened whenever two hosts pointed at the same
workspace: both read the same snapshot and the later write dropped the
earlier one's entry. The state files are now serialised across
processes with a lock file.

**It can still happen when the workspace lives in a sync folder**
(Dropbox, iCloud, Google Drive). Exclusive file creation gives no
exclusion there — the file is replicated after the fact, so both hosts
believe they hold the lock. No mechanism in the app can fix that.

### Fix

Move the workspace onto a real filesystem. A network mount is fine
(`O_EXCL` is atomic on NFSv3+); a consumer sync folder is not.

Nothing is lost while it persists: the push REFUSES rather than
overwrites, which is exactly what the conflict report means. If the
workspace is already on a real filesystem and a conflict still will not
clear, that is a new bug — report it with the calendar id and the
record.

## `proceeding without the calendar state lock` in the logs

### Symptoms

A `google` warning naming a `.lock` path, during a calendar sync.

### Cause

The lock guards one read-modify-write of a calendar state file, and it
fails OPEN: a host that cannot take it does its work anyway, because
the lock removes a race rather than being a precondition for syncing
correctly.

A single occurrence is normal — another host held the file for the few
milliseconds the mutation takes.

### Fix

Nothing, if it is occasional. If it is constant, either another host is
hammering the same workspace, or the lock file cannot be created at all
(a read-only mount, a missing `data/calendar` directory, a full disk) —
check those before treating it as a calendar problem.

## Fallback

If none of the above matches the failing tool output:

1. `ls config/helps/` to see every shipped help file.
2. Pick the file whose name most closely matches the failing area
   (`sandbox.md`, `github.md`, `feeds.md`, `presentation-deck.md`,
   `mulmoscript.md`, `spreadsheet.md`, etc.) and Read it.
3. If you find a fix there, apply it and cite the help by path in
   your reply.
4. If nothing fits, surface the raw error to the user and say
   "no documented fix found in `config/helps/` — could you share more
   context so we can resolve this together?" rather than silently
   guessing or retrying the same command.

## When you discover a new common error

If you resolve a new class of error that other users are likely to
hit, suggest to the user that we extend this file. Don't edit it
yourself — additions to `config/helps/error-recovery.md` are managed
by the project maintainers so the canonical copy in
`packages/core/assets/helps/error-recovery.md` and the installed copy
stay in sync.

## Sandbox MCP server dies at load — `Cannot find module '@…/…'`

### Symptoms

- Chatting fails before any tool runs, with:
  `Error: MCP tool mcp__mulmoclaude__handlePermission (passed via --permission-prompt-tool) not found.`
- Or, in the server log: `[agent-stderr] Error: Cannot find module '@mulmobridge/protocol'`
  (or `@mulmoclaude/chart-plugin`, `@gui-chat-plugin/camera`, …) followed by a `Require stack:`
  listing `/app/server/agent/mcp-server.ts`.
- Sandbox (Docker) mode only. The broker dies **permanently** — it fails on every manual retry
  too (contrast the transient scheduler race below, which succeeds on a manual re-run).
- Three causes share this message. Only this one names a missing module in the log; if the log
  has no `Cannot find module`, check the scheduler race and the frozen-CLI section below.

### Cause

The MCP child resolves its imports against `/app/node_modules` plus the `/app/pkg_modules`
fallback on `NODE_PATH`. It dies at load when a package it imports is reachable from neither. Two
layouts cause that:

1. **Windows source checkout.** `yarn` links workspace packages into `node_modules/` as **NTFS
   junctions**; their absolute Windows target (`C:\Users\…`) does not exist in the Linux container,
   so every junction dangles. `server/agent/config.ts` bind-mounts a junction-free copy of each
   workspace package at `/app/pkg_modules/<name>`; a package missing from that list is invisible.
2. **npx install with nested `node_modules`.** npm sometimes places a dep in the nested
   `<packageRoot>/node_modules` (a version conflict, or a half-deduped npx cache from repeated
   overwrite-updates) instead of hoisting it to `<projectRoot>/node_modules`. Only the latter is
   mounted to `/app/node_modules`, so the nested dep is invisible.

Either way the child dies before the MCP handshake, so the agent loses **every** MCP tool at once —
`handlePermission` included, which is why the CLI complains about the permission-prompt tool rather
than about the missing module.

### Fix

Both layouts are handled automatically: the Windows case mounts every workspace scope, and the npx
case mounts the nested `<packageRoot>/node_modules` onto `/app/pkg_modules`. If you see this anyway:

```bash
# Check the SHIPPED mount list, not a hand-mounted copy: does the package the
# child failed on appear in what workspaceModuleMounts() actually produces?
node_modules/.bin/tsx test/sandbox-repro/print-mcp-container-spec.ts \
  | grep pkg_modules/<name>       # <name> e.g. @mulmobridge/protocol

# The workspace dists must exist — production ships built output.
yarn build:packages:dev
```

A stale `dist/` looks identical from the outside: the mount is there, but its `exports` target is
absent. Rebuild before suspecting the mounts.

For an **npx** install specifically, the quickest user-side unblock is to clear the npx cache so
the next launch installs a clean, fully-hoisted tree:

```bash
rm -rf ~/.npm/_npx        # then re-run:
npx mulmoclaude@latest
```

## Scheduled run fails once with `handlePermission not found`, but works on a manual retry

### Symptoms

- A scheduled skill / user task fails with the SAME
  `MCP tool mcp__mulmoclaude__handlePermission ... not found` message — but running the identical
  skill by hand immediately afterwards succeeds.
- More frequent when several tasks are scheduled for the same minute (e.g. multiple 20:00 UTC
  jobs). The failed run's transcript is tiny (a few hundred bytes to a few KB) and its recorded
  duration is only milliseconds.

### Cause

This is a transient STARTUP RACE, not the permanent load failure above. Each scheduled chat spawns
its own `mulmoclaude` MCP broker; when many chats launch in the same instant the broker boots under
contention and can connect a moment after the agent's first tool call, so the permission-prompt
tool is briefly absent. The broker connects seconds later — which is why a manual re-run works.

The scheduler now staggers same-minute firings by a second each to reduce this contention (#2057),
so it should be rare. It is NOT a module-resolution problem — the mounts / `dist` are fine.

### Fix

Just re-run the task. If it recurs often on a busy schedule, spread the tasks across different
minutes rather than stacking them on the same one.

If a manual re-run fails too, it isn't this race — check the frozen-CLI section below.

### Regression coverage

`.github/workflows/docker_sandbox_windows.yaml` boots the real `mcp-server.ts` inside a Linux
container from a Windows host (WSL2 + native `dockerd`), with the same mounts / env / argv the
shipped builders produce, and asserts `handlePermission` comes back over the MCP handshake. See
`docs/windows-docker-ci.md`.

## Sandbox CLI frozen at an old version — `handlePermission not found` that `docker rmi` won't fix

### Symptoms

- The SAME `MCP tool mcp__mulmoclaude__handlePermission ... not found` message as the two
  sections above. Sandbox (Docker) mode only.
- Fails on cold start and the automatic replay fails with it, so it looks like the permanent
  load failure — but the mounts and `dist` are fine.
- The tell: the CLI **inside the image** is older than the host's. Anything before 2.1.206
  crashes when `--permission-prompt-tool` is referenced before the broker connects, instead
  of waiting for it.
- Deleting the image (`yarn sandbox:remove`) and letting it rebuild leaves the version
  unchanged.

### Cause

`Dockerfile.sandbox` installs the CLI unpinned (`RUN npm install -g @anthropic-ai/claude-code
tsx`), so the image freezes whatever was latest when it was built. Two mechanisms then keep it
frozen:

1. `ensureSandboxImage()` (`server/system/docker.ts`) rebuilds only when the **Dockerfile's
   SHA** changes. A new CLI release upstream doesn't change that SHA, so nothing retriggers.
2. Deleting the image does not delete the **build cache**. The rebuild reuses the cached
   `npm install -g` layer (it reports `CACHED` in 0.0s) and reinstalls nothing.

So the usual "remove it and let it rebuild" reflex genuinely does nothing here, which is why
this one burns time.

### Fix

Check the version inside the image — the host's `claude --version` says nothing about it, and
the entrypoint override is required because the image's ENTRYPOINT is the sandbox script:

```bash
docker run --rm --entrypoint claude mulmoclaude-sandbox --version
```

If it's behind, drop the image AND the build cache, then let the next run rebuild:

```bash
yarn sandbox:remove          # docker rmi mulmoclaude-sandbox
docker builder prune -a -f   # the step that actually invalidates the npm layer
```

`docker builder prune -a -f` clears the builder cache for the whole daemon, not just this
image, so unrelated builds are slower once afterwards. That is the cost of the fix, not a
sign something went wrong.

The CLI is deliberately left unpinned (#2202), so this can recur whenever an upstream fix
matters to you — the check above is the way to rule it in or out.

---

## Google tool — link / credential / API errors

### Symptoms

- The `google` tool (or a `google.calendar.*` remote command) fails with **"Google account not linked on this host"**.
- **"Google sign-in service unreachable"** or **"Google sign-in service returned HTTP …"**.
- **"multiple client_secret_*.json files found"**.
- **"Google Calendar API: HTTP 403"** with a hint about enabling the API.
- **"Google Calendar API: HTTP 403 — Request had insufficient authentication scopes"** when pushing
  a collection to a calendar that is NOT in the account's own calendar list.
- **"could not obtain a Google access token"** (grant revoked).
- `calendarListCalendars` / non-primary calendar lookups fail with **HTTP 401/403 / insufficient scope**, or the list comes back empty even though the user has other calendars.

### Cause

The `google` tool runs against a Google account linked **locally on this machine** — a refresh
token stored at `~/.config/mulmo/google-token.json` (mode 600), obtained through a browser
consent (loopback + PKCE). This is independent of claude.ai Google connectors.

Two ways the link can be minted, and the tool picks automatically:

- **Default**: the user just clicks link and consents. The mulmoserver broker applies the OAuth
  client secret for the token exchange / renewal (Google requires one); it stores nothing —
  the tokens live only on this machine. **The user needs no Google Cloud setup.**
- **Own client** (advanced / self-hosters): if `~/.secrets/client_secret_*.json` exists, the
  whole flow stays on this machine and the broker is never contacted.

### Fix

- **Not linked / grant revoked** — ask the user to link (or re-link) the account from this app's
  settings, then retry. Do NOT tell them to create a Google Cloud project, and do NOT try to
  create or edit the token file yourself.
- **Calendar-list / non-primary lookup fails with insufficient scope (or lists nothing)** — the
  account was linked before the calendar-list read scope (`calendar.calendarlist.readonly`) was
  added, so the stored grant predates it. Ask the user to re-link from settings to add the scope,
  then retry. Reading events on a non-primary calendar by id needs no re-link once the calendar
  list is visible.
- **Sign-in service unreachable / HTTP error** — the broker is down or the network is blocked.
  It is only needed to link and to renew an expired access token; ask the user to retry shortly.
  (A user with their own `~/.secrets/client_secret_*.json` never depends on it.)
- **Multiple client secrets** — the user has several `client_secret_*.json` in `~/.secrets/`;
  a stored refresh token pairs with exactly one OAuth client, so the choice is refused rather
  than guessed at. Ask them to keep one — or remove all of them to use the default flow.
- **403 "insufficient authentication scopes" pushing to a calendar not in the user's list** —
  read the 403's BODY before the bullet below, which does not apply here: this one is about the
  grant, not the Cloud project, so enabling an API changes nothing. On hosts predating the #2735
  fix (`@mulmoclaude/core` 1.13.0 and earlier) the push asked `calendars.get` for that calendar's
  timezone, and NONE of the four scopes this app requests grants that call, so it failed for every
  account ever linked. **Re-linking does not help either** — consent grants the same four scopes.
  Either update the host, or have the user **add the shared calendar to their own Google Calendar
  list** (Other calendars → Subscribe), after which the push reads its timezone and role from the
  list and never takes that path. A calendar the user has already added was never affected.
- **HTTP 403 naming a Google API** — the API is not enabled for the Cloud project behind the
  client in use. With their own client, ask them to enable that API in the Cloud Console
  (APIs & Services → Library — the error names it: "Google Calendar API", "Google Tasks API",
  or "Google Drive API"), then retry — no re-link needed. On the default (broker) flow this
  should not happen; report it rather than sending the user to the Console.
- **Drive shows nothing / "I can't find the user's file"** — not an error. The app holds the
  `drive.file` scope, so it can only ever see files IT created; the user's wider Drive is
  invisible by design. Say so plainly instead of implying an empty Drive.

## Custom view — some images 429 / only a few thumbnails render

### Symptoms

- A collection's custom view renders records fine, but only a handful of its
  `image`-type field thumbnails appear; the rest stay placeholders.
- The view's error UI (or console) shows **HTTP 429** from
  `<dataUrl>/image` with **"too many concurrent queries for this collection —
  retry shortly"**.

### Cause

The view resolves every image at once — typically a `Promise.all` over all
records firing one `GET <dataUrl>/image` each. The host caps in-flight
`/image` + `/query` requests at **4 per collection** (each request re-scans
the records for authorization), and answers the overflow 429. The paths are
valid; only the burst is.

### Fix

Edit the view's image-resolution code (`views/*.html` under the collection's
skill directory) to throttle: a small worker pool (≤ 3 concurrent) draining a
queue of paths, with one short-delay retry on 429. See the throttled-resolver
example in `custom-view.md` ("Displaying images"). Do NOT widen the server
cap, switch to base64-embedding images in the HTML, or treat the 429'd paths
as bad values.

## An API key in `.env` has no effect — the shell is shadowing it

### Symptoms

- The user says they put a key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) in
  `.env` and restarted, but generation still fails with an auth / 401 /
  "API key not valid" error from the provider.
- They may have edited `.env` several times, each time with no change.
- The bell may show **"Shell env is overriding .env"**, and the server log
  a `[shadowed-env]` warning naming the keys.

### Cause

An exported shell variable beats the file. `.env` is loaded with
no-override semantics, so if `~/.zshrc` (or the current shell) still holds
`export GEMINI_API_KEY=<old value>`, the file's value is read and
discarded. Editing `.env` cannot fix it, which is why the loop repeats.

An **empty** export shadows just as hard: `export GEMINI_API_KEY=` counts
as set, so the provider receives an empty key while a perfectly good one
sits in `.env`.

Two files can be shadowed this way — the directory the user launched from
(`npx mulmoclaude`) and the server's own working directory (`yarn dev`).

### Fix

Have the user check the shell, not the file. Test whether the variable
is **set**, not whether it prints something — `export GEMINI_API_KEY=`
prints nothing and still shadows, which is the case `echo` cannot see:

```bash
[ -n "${GEMINI_API_KEY+x}" ] && echo "set in the shell — this is what the app uses" \
                             || echo "not set — the shell is not the problem"
```

If it reports "set", that shell value is what the app is using, whatever
`.env` says. Either correct the export, or remove it — from the current
shell AND from `~/.zshrc` / `~/.bashrc`, or the next terminal brings it
straight back — so the `.env` value takes effect. Restart the app
afterwards; the load happens once at boot.

Do NOT tell the user to re-check the spelling in `.env`, add the key
again, or move it elsewhere; the file is already correct, and it is being
read. The conflict is the whole problem.

## A tool your own instructions describe returns "No such tool available"

### Symptoms

- The Plugin Instructions section of your system prompt documents a tool
  (`mcp__mulmoclaude__google`, `mcp__mulmoclaude__manageSpotify`, any
  plugin-backed name), but calling it errors with `No such tool available`.
- `ToolSearch select:<that name>` reports no matching deferred tool either.
- Static tools in the same session (`presentDocument`, `presentForm`, …) work.

### Cause

The tool surface is published by a separate MCP broker process, and plugin-backed
tools register there a moment after the session's tool list is first taken. A
session that captured the list too early keeps one that lacks exactly those
tools — while the system prompt, built in the server where the plugin IS
registered, still describes them.

### Fix

Tell the user plainly that the tool is unavailable in THIS session and that
starting a new chat re-takes the tool list. Do NOT invent a fallback: reading
the account's stored credentials, shelling out to a provider CLI, or
reconstructing the call by hand is worse than the missing tool, and it is not
what the user asked for.

If a new chat has the same gap, the broker did not publish the tool at all.
Ask the user for the server log around the session start — the broker prints
`[mcp-server] publishing N tools: …` and, when a promised tool is missing,
`[mcp-server] advertised but NOT published (check plugin load above): …`. That
second line, with the plugin-load errors above it, is what a bug report needs.
