# Installing dsh-download

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) that adds one model-facing tool,
`download_file`, plus a download panel under **Settings → Plugins → 下载**.

Everything below assumes **dsh is already installed** on the machine. This plugin does not install
dsh, and it has **no npm dependencies** — it is plain JavaScript importing only Node builtins, so
there is nothing to build and nothing to fetch.

---

## Requirements

| | |
| --- | --- |
| dsh | Any build that supports `dsh.bundle` plugin bundles and a Web profile (the panel needs the Web surface). |
| Node.js | 18 or newer, for `fetch` and `Readable.fromWeb`. dsh's own runtime satisfies this. |
| Neat Download Manager | **Optional.** Only the `ndm` engine needs it, and it is Windows-only. The default `builtin` engine needs nothing installed. |
| pnpm | Only for `dsh plugin add` (which forwards to pnpm in the profile directory). |

---

## Install, the normal way

From the folder that contains this plugin (the folder with `package.json`, `lib/`, `cordis.patch.yml`):

```powershell
dsh plugin --profile web add "<path-to-this-folder>"
```

Substitute your profile name for `web` if you boot a different one (`dsh --profile <name>`). The
command forwards to pnpm inside `$DSH_HOME/profiles/<name>` and then reconciles that profile's
`dsh.profile.bundles` list, which is what makes the plugin a layer of the composed tree.

**Verify before restarting:**

```powershell
dsh --profile web --dump-config | Select-String tool-dsh-download
```

That must print the `tool-dsh-download` row. If it does not, the bundle layer is not being read —
do not restart yet, fix that first (see *Troubleshooting*).

Then restart dsh. Two things should be true afterwards:

1. the model has a `download_file` tool;
2. **Settings → Plugins → 下载** exists.

### On Windows, without a terminal (recommended)

Double-click `install.cmd`. It runs `install.ps1`, which does the wiring **itself, offline** — it does
not call `dsh plugin add`, so it needs neither pnpm nor the network:

1. validates the folder (manifest, bundle patch, engine file all present);
2. checks Node — and refuses if it is older than 18;
3. finds dsh: PATH, `where.exe`, npm's global prefix and root, **npm's npx cache**, pnpm's global
   root, then the conventional per-user and per-machine folders. It prints where it looked if it
   finds nothing;
4. locates `$DSH_HOME` (or `%USERPROFILE%\.dsh`) and the target profile, refusing with instructions
   if the profile does not exist yet;
5. **backs up** the profile's `package.json` before touching it;
6. declares the dependency `link:<this folder>` in that manifest;
7. adds this plugin's row to `dsh.profile.bundles`;
8. links this folder into the profile's `node_modules` — **building the link under a temporary name
   first and only swapping it in once it is known to work**, retrying up to five times (security
   software such as 360 Security Guard can refuse a link creation briefly, and that is not fatal);
9. smoke-tests the bundled engine with the local Node;
10. verifies with `dsh --profile <name> --dump-config` that the row composed, and **rolls the
    manifest and the link back** if it did not.

The profile's manifest and the link are restored on any failure, so a failed install leaves the
machine as it was.

`-ExecutionPolicy Bypass` is passed explicitly, because script execution is disabled by policy on
many Windows machines, which is why the `.ps1` cannot simply be double-clicked. Useful switches:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Profile tui       # another profile
powershell -ExecutionPolicy Bypass -File install.ps1 -DshPath "C:\path\to\dsh.cmd"
powershell -ExecutionPolicy Bypass -File install.ps1 -NoVerify          # skip --dump-config
```

### When dsh is not installed globally

A machine where dsh has only ever been started with `npx` has no `dsh` on PATH: it lives in npm's
cache, and the `_npx\...\.bin` entry that makes the command work exists **only inside the process
npx started**. A new shell launched by `install.cmd` does not inherit it.

The installer handles this: it asks npm where its cache is and looks for
`<cache>\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js`, preferring the newest match. It then warns,
because that folder belongs to the cache rather than to an installation you chose — a later `npx`
run can replace it and `npm cache clean` removes it. The plugin itself is unaffected (the profile
links to this plugin's own folder), but for a setup that does not depend on the cache:

```powershell
npm i -g @deepseek-ai/dsh
```

You can always point at dsh explicitly instead. Both forms are accepted — the shim, or dsh's own
entry point (which is run with Node):

```powershell
install.cmd -DshPath "C:\path\to\dsh.cmd"
install.cmd -DshPath "C:\Users\you\AppData\Local\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

### If a security suite blocks the installer

360 Security Guard, Defender and similar products treat folder-link creation as suspicious (it is a
technique malware uses) and can refuse it intermittently, and they can also block the helper
commands the installer runs (`where.exe`, `npm`). Symptoms are a link error that disappears on a
retry, or dsh reported as not found even though it is installed. Allow this script in the suite, or
suspend it while installing.

### From a git host

```powershell
dsh plugin --profile web add github:<user>/<repo>
```

No build step is involved, so no pnpm `allowBuilds` entry is needed — that is only required for
plugins whose install runs a `prepare` script.

---

## Install by hand (no pnpm)

A dsh plugin is just a package that a profile depends on, so three edits do it:

1. Put this folder somewhere permanent and make it reachable from the profile, e.g. a junction:

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-download" `
            -Target "C:\path\to\dsh-download"
   ```

   On Linux/macOS the equivalent is `ln -s /path/to/dsh-download ~/.dsh/profiles/web/node_modules/dsh-download`.

2. Add it to `~/.dsh/profiles/web/package.json`:

   ```json
   {
     "dependencies": { "dsh-download": "link:C:/path/to/dsh-download" },
     "dsh": { "profile": { "bundles": ["…existing…", "dsh-download"] } }
   }
   ```

3. Restart dsh and confirm the row with `dsh --profile web --dump-config`.

The plugin must be **last** in `bundles` only if you want its patch applied after the others; order
does not matter for it functionally because it publishes no service.

---

## First run, and settings

On first load the plugin writes a documented settings file:

```
%DSH_HOME%\dsh-download.settings.json          default: C:\Users\<you>\.dsh\dsh-download.settings.json
```

It **never overwrites an existing file**. The panel can edit the built-in engine's own settings
(segment count, segmentation threshold, default download folder); everything else is edited in the
file, and edits apply to the next download with no restart.

Download records and live progress live in:

```
%DSH_HOME%\dsh-download.status.json            (bounded: newest 25 entries)
```

The panel reads both through two read-only routes registered on the dsh web server
(`/dsh-download/status.json`, `/dsh-download/settings.json`), plus one write route for the settings
the panel is allowed to change.

---

## Verifying it actually works

1. **The tool exists.** Ask dsh to download something small and let it use the tool; the result is
   one line: `OK 64 B -> <path> (built-in, single-stream, …)`.
2. **Out-of-band check.** `Get-Item $env:USERPROFILE\.dsh\dsh-download.status.json` exists and its
   `recent` array contains the entry.
3. **The panel.** Settings → Plugins → 下载 shows the record and a progress bar for anything in
   flight. Close the tab: polling stops entirely (the panel only refreshes while it is displayed).
4. **A destination test.** Download twice the same URL to an explicit path on a second drive and
   confirm the bytes are there:
   `download_file { url, dest: "D:\\somewhere\\file.bin" }`, then compare the sha256 with the
   publisher's.

---

## Platform notes, stated honestly

| Platform | Status |
| --- | --- |
| **Windows** | Full support. Both engines work; the NDM engine needs Neat Download Manager installed. |
| **Linux / macOS** | The **built-in engine** is expected to work: it uses only Node builtins and has no platform-specific calls, no native modules, and no NDM dependency. Install with `dsh plugin add` — `install.cmd`/`install.ps1` and the PowerShell settings wizard do not apply (the wizard needs `pwsh`). |
| **Not yet proven** | The Linux/macOS claim above is from reading the code, not from running it. Add the repository's CI workflow to prove it on every push before trusting it. |

The NDM engine is Windows-only by nature: it drives a Windows program and reads its settings from
the registry. With `engine: "builtin"` (the default) nothing else in the plugin cares which OS it is
on.

---

## Uninstall

```powershell
dsh plugin --profile web remove dsh-download
```

Then delete the folder, and optionally these leftovers in `$DSH_HOME`:

- `dsh-download.settings.json` — your settings;
- `dsh-download.status.json` — the download history.

The plugin writes nothing else outside a download's own destination (temporarily
`<dest>.part` and `<dest>.part.json` while a transfer is in flight or interrupted; both are removed
when it completes).

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `download_file` does not exist | The bundle layer is not composed. Check `dsh --profile <name> --dump-config` for the `tool-dsh-download` row, and that the profile's `dsh.profile.bundles` names this plugin. |
| No download tab in Settings → Plugins | The client half is not being served. Open `http://127.0.0.1:<port>/plugins/dsh-download/client.js` — it must return JavaScript, not the SPA's HTML. If it returns HTML, dsh was not restarted after installing. |
| The tool works but the panel says it cannot read the status | Same as above; the routes are registered at startup. Restart dsh. |
| `Neat Download Manager was not found` | You are on the `ndm` engine without the program installed. Either install it, set `ndmPath` in the settings file, or switch back with `"engine": "builtin"`. |
| A download stops part-way | It is resumable: call `download_file` again with the **same `dest`** and it continues from the last byte written. Partial work sits in `<dest>.part` with its state in `<dest>.part.json`. |
| `429` / `418` errors from a mirror | The engine backs off and halves its in-flight requests automatically, and retries the opening probe. Persistent failures mean the mirror is rate-limiting the machine — lower `builtinConnections`. |
| Port 3080 already in use | Another dsh instance is running. Use `dsh web --port <other>`. |
