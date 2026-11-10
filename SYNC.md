# SYNC: put this PC on the `maul-fixes` branch

This file is for any AI agent (or person) that has to make flow-mcp on another PC the same as on the main PC.
Follow the steps in order. Do not skip a step. Do not change the commands.

- Code lives on GitHub: `https://github.com/muhamadmaulanaihsanekg/flow-mcp`, branch **`maul-fixes`**.
- `upstream` (`GTAI-1/flow-mcp`) is the original project. We can NOT push there. Never try.
- One script does all the work: `scripts/sync-maul.mjs`. It is safe to run many times.

---

## A. Get changes onto this PC (pull)

### Step 1 — Close everything that runs flow-mcp

Close: Claude Desktop, Claude Code, pi, Codex, Antigravity, Flow Studio. If unsure, also end every `node`
process in Task Manager (Windows) / Activity Monitor (Mac).
Why: on Windows a running flow-mcp locks its files and the install fails.

### Step 2 — Run the sync script

Open a terminal in your HOME folder and paste ONE block. Pick the block for your terminal.

**Windows PowerShell** (use `curl.exe`, not `curl`):
```powershell
cd $HOME
curl.exe -fsSL https://raw.githubusercontent.com/muhamadmaulanaihsanekg/flow-mcp/maul-fixes/scripts/sync-maul.mjs -o sync-maul.mjs
node sync-maul.mjs
```

**Git Bash / Mac / Linux:**
```bash
cd ~
curl -fsSL https://raw.githubusercontent.com/muhamadmaulanaihsanekg/flow-mcp/maul-fixes/scripts/sync-maul.mjs -o sync-maul.mjs
node sync-maul.mjs
```

flow-mcp in another folder (not `<home>/flow-mcp`)? Add `--dir`, e.g. `node sync-maul.mjs --dir D:\tools\flow-mcp`.

### Step 3 — Read the output

The script prints `=== STEP 1` … `=== STEP 6` and ends with `=== DONE`.

| You see | Do this |
|---|---|
| `=== DONE` | Go to Step 4. |
| `!!! STOPPED` | Do exactly what the `FIX:` line says, then run `node sync-maul.mjs` again. |
| `WRONG <config file>` | Open that file, change the flow path to the path the script printed after `OK: built`, save. |
| `NOTE: No AI app points at this build yet` | Copy the printed `"flow": { ... }` line into the app's MCP config, inside `"mcpServers"`. |
| `NOTE: Never signed in on this PC` | Run the printed `npm run login` command, sign in to Google in the window that opens, close it. |
| `NOTE: Local changes were saved in git stash` | Nothing to do now. Your old edits are kept; see "Old local edits" below. |

### Step 4 — Restart and check

1. Close the Chrome window that flow-mcp opened (the Flow window), if it is open.
2. Start the AI app again.
3. In the AI app, call the tool `flow_status`.
4. The answer MUST contain the word `lanes`. Yes → this PC is in sync. No → go back to Step 1.

---

## B. Send changes from this PC (push)

Only when flow-mcp code was changed on THIS PC and the other PC must get it.

```bash
cd ~/flow-mcp
git switch maul-fixes
git add src scripts README.md SYNC.md CLAUDE.md
git commit -m "fix: <what changed, in one line>"
git push origin maul-fixes
```

- Push is refused ("rejected", "fetch first")? Run `git pull --rebase origin maul-fixes`, then `git push origin maul-fixes` again.
- Never `git push upstream`. Never push to `main`.
- Do not add `debug-*.png`, `dist/` or `node_modules/`.
- After the push, on the OTHER PC do part A.

---

## C. Get new updates from the original project (optional)

```bash
cd ~/flow-mcp
git fetch upstream
git switch maul-fixes
git merge upstream/main
npm ci
npm run build
git push origin maul-fixes
```

A merge conflict? Stop and ask a capable AI or a person. Do not guess.

---

## Old local edits

If the script put local edits in the stash: `git stash list` shows them, `git stash pop` brings them back
(only do that if you still need them).

## What this branch adds (so you know what you are checking)

- **Lanes:** every AI session gets its own Flow window, project and queue; sessions run at the same time.
  New tool `flow_open_project`. `flow_status` shows `lanes`. Optional env `FLOW_MCP_LANE` = fixed lane name.
- **Omni 1.2 Flash:** video `duration` any whole second 3–15.
- **Flow UI fixes:** new selectors (settings, agent chip) and a sturdier download.
