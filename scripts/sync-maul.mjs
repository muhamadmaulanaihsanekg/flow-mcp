#!/usr/bin/env node
// Puts this PC's flow-mcp on the same code as the `maul-fixes` branch, builds it, and checks that every AI app
// points at it. Safe to run again and again: each run only does what is still missing.
//
// Usage (any folder):  node sync-maul.mjs            -> uses <home>/flow-mcp
//                      node sync-maul.mjs --dir D:\x -> uses that folder
// Full guide: SYNC.md in the same branch.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const FORK = "https://github.com/muhamadmaulanaihsanekg/flow-mcp.git";
const UPSTREAM = "https://github.com/GTAI-1/flow-mcp.git";
const BRANCH = "maul-fixes";
const MARKER = "flow_open_project"; // a tool that only exists in this branch's build

const at = process.argv.indexOf("--dir");
const DIR = resolve(at > 0 ? process.argv[at + 1] : join(homedir(), "flow-mcp"));
const WIN = process.platform === "win32";

let stepNo = 0;
const step = (text) => console.log(`\n=== STEP ${++stepNo}: ${text}`);
const ok = (text) => console.log(`    OK: ${text}`);
const note = (text) => console.log(`    NOTE: ${text}`);
function stop(problem, fix) {
  console.log(`\n!!! STOPPED at step ${stepNo}.\n    PROBLEM: ${problem}\n    FIX: ${fix}\n    Then run this script again.`);
  process.exit(1);
}
function run(cmd, args, cwd = DIR, quiet = false) {
  if (!quiet) console.log(`    > ${cmd} ${args.join(" ")}`);
  // npm is a .cmd file on Windows and only starts through the shell; its arguments here are fixed words, never input.
  const viaShell = WIN && cmd === "npm";
  const r = viaShell
    ? spawnSync(`${cmd} ${args.join(" ")}`, { cwd, encoding: "utf8", shell: true, stdio: quiet ? "pipe" : "inherit" })
    : spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const git = (...args) => run("git", args, DIR, true);
const hashOf = (f) => (existsSync(f) ? createHash("sha1").update(readFileSync(f)).digest("hex") : "none");

step("Check that git, node and npm are installed");
for (const [cmd, args] of [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]]]) {
  const r = run(cmd, args, homedir(), true);
  if (r.code !== 0) stop(`"${cmd}" is not installed or not on PATH.`, `Install ${cmd === "git" ? "Git (git-scm.com)" : "Node.js 20 or newer (nodejs.org)"}, open a NEW terminal.`);
  ok(`${cmd} ${r.out.split("\n")[0]}`);
}
if (Number(process.versions.node.split(".")[0]) < 20) stop(`Node ${process.versions.node} is too old.`, "Install Node.js 20 or newer from nodejs.org.");

step(`Get the code into ${DIR}`);
const lockBefore = hashOf(join(DIR, "package-lock.json"));
if (!existsSync(DIR)) {
  const r = run("git", ["clone", "-b", BRANCH, FORK, DIR], homedir());
  if (r.code !== 0) stop("git clone failed.", "Check the internet connection, then run again.");
  ok("cloned");
} else {
  if (!existsSync(join(DIR, ".git"))) stop(`${DIR} exists but is not a git folder.`, `Rename that folder (e.g. to flow-mcp-old) so a fresh copy can be cloned.`);
  // Remotes: origin = the fork (where maul-fixes lives), upstream = the original project.
  const remotes = git("remote").out.split(/\s+/).filter(Boolean);
  const urlOf = (name) => (remotes.includes(name) ? git("remote", "get-url", name).out : "");
  if (urlOf("origin") && !/muhamadmaulanaihsanekg\/flow-mcp/.test(urlOf("origin"))) {
    if (!remotes.includes("upstream")) git("remote", "rename", "origin", "upstream");
    else git("remote", "remove", "origin");
  }
  const now = git("remote").out.split(/\s+/);
  if (!now.includes("origin")) git("remote", "add", "origin", FORK);
  else git("remote", "set-url", "origin", FORK);
  if (!now.includes("upstream")) git("remote", "add", "upstream", UPSTREAM);
  ok(`origin = ${FORK}, upstream = ${UPSTREAM}`);

  // Local edits are never thrown away: they are put in the stash first.
  const dirty = git("status", "--porcelain", "--untracked-files=no").out;
  if (dirty) {
    const name = `sync-maul backup ${new Date().toISOString().slice(0, 16)}`;
    if (git("stash", "push", "-m", name).code !== 0) stop("Could not set aside local changes.", "Run `git status` in the folder and commit or undo the changes.");
    note(`Local changes were saved in git stash as "${name}". Get them back later with: git stash list / git stash pop`);
  }
  if (run("git", ["fetch", "origin"]).code !== 0) stop("git fetch failed.", "Check the internet connection.");
  const hasLocal = git("rev-parse", "--verify", "--quiet", BRANCH).code === 0;
  if (!hasLocal) {
    if (run("git", ["checkout", "-b", BRANCH, "--track", `origin/${BRANCH}`]).code !== 0) stop(`Could not switch to ${BRANCH}.`, "Run `git status` and read the message.");
  } else {
    if (run("git", ["checkout", BRANCH]).code !== 0) stop(`Could not switch to ${BRANCH}.`, "Run `git status` and read the message.");
    if (run("git", ["merge", "--ff-only", `origin/${BRANCH}`]).code !== 0)
      stop(
        `This PC has its own commits on ${BRANCH} that are not on GitHub, so it cannot simply move forward.`,
        `Push them first from this PC: git push origin ${BRANCH}  (if that is refused: git pull --rebase origin ${BRANCH}, then git push origin ${BRANCH}).`,
      );
  }
  ok(`on ${BRANCH} at ${git("log", "-1", "--format=%h %s").out}`);
}

step("Install packages (only when they changed)");
const lockAfter = hashOf(join(DIR, "package-lock.json"));
if (lockBefore === lockAfter && existsSync(join(DIR, "node_modules"))) ok("package-lock.json unchanged, node_modules present: skipped");
else if (run("npm", ["ci"]).code !== 0)
  stop(
    "npm ci failed. On Windows this is almost always a running flow-mcp holding files open.",
    "Close every AI app that uses flow-mcp (Claude, pi, Codex, Antigravity) and Flow Studio, or end the `node` processes in Task Manager.",
  );
else ok("installed");

step("Build");
if (run("npm", ["run", "build"]).code !== 0) stop("The build failed.", "Read the error above; send it to the AI that maintains flow-mcp.");
const built = join(DIR, "dist", "index.js");
if (!existsSync(built) || !readFileSync(built, "utf8").includes(MARKER)) stop("dist/index.js is missing or old.", "Run `npm run build` in the folder and read the error.");
ok(`built ${built}`);

step("Check which AI apps point at this flow-mcp");
const want = built.toLowerCase().replace(/\\/g, "/");
const configs = [
  join(homedir(), ".pi", "agent", "mcp.json"),
  join(homedir(), ".claude.json"),
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".gemini", "settings.json"),
  join(homedir(), ".gemini", "antigravity", "mcp_config.json"),
  process.env.APPDATA ? join(process.env.APPDATA, "Claude", "claude_desktop_config.json") : join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
];
let pointing = 0;
for (const file of configs) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  const paths = [...text.matchAll(/["']([^"']*flow-mcp[^"']*index\.js)["']/gi)].map((m) => m[1]);
  if (!paths.length) continue;
  for (const p of paths) {
    const same = p.toLowerCase().replace(/\\\\/g, "/").replace(/\\/g, "/") === want;
    console.log(`    ${same ? "OK  " : "WRONG"} ${file}\n          uses ${p}`);
    if (same) pointing++;
  }
}
const jsonPath = built.replace(/\\/g, "\\\\");
if (!pointing) {
  note("No AI app points at this build yet. Add this to the app's MCP config (pi: ~/.pi/agent/mcp.json, inside \"mcpServers\"):");
  console.log(`      "flow": { "command": "node", "args": ["${jsonPath}"] }`);
} else note(`Any line marked WRONG above: change that path to ${built}`);

step("Sign-in check");
const profile = join(process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp"), "chrome-profile");
if (existsSync(profile)) ok("Flow Chrome profile exists (signed in before)");
else note(`Never signed in on this PC. Run once:  cd "${DIR}"  then  npm run login  and sign in to Google in the window that opens.`);

console.log(`
=== DONE. Two things left for you:
    1. Close the Flow Chrome window (the one flow-mcp opened), then restart every AI app that uses flow-mcp.
    2. In the AI app call flow_status. The answer must contain "lanes". If it does, this PC matches.`);
