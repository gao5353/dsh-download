# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org): a
breaking change for an existing installation bumps the major version.

## Unreleased

- **A connection that goes silent is abandoned and retried instead of held forever.** A mirror that
  answered a range request with headers and then sent nothing left the call sitting at a fully
  preallocated destination with no error and no progress; nothing in the engine bounded that silence,
  so the only way out was to kill it. Every range request now has its own timer (`stallMs`, default
  60 s, reset whenever bytes arrive, `0` disables), including the opening probe — which is the first
  request of a call and therefore the first place a silent server could hang it. A real stall is
  retried like any other failure, and if it never recovers the result says which range went quiet for
  how long instead of surfacing a bare `AbortError`. `waitMs` still stops the transfer, but it no
  longer aborts the probe: doing so meant the result could not report the file's size, and a stop
  that cannot say how much is left is less useful than one that waits for the answer.
- **One less copy of every byte.** Each body chunk was duplicated before being coalesced into a
  write; it is now handed on as a view, so the engine pays for one pass over the data instead of two.
  This is a strict reduction in work, but the measured effect sits inside the noise of the local
  benchmark (±10–20 % between identical runs), so it ships for the work it removes rather than for a
  number it cannot honestly demonstrate.
- **A note on the 2.5× figure.** It comes from one measured pair of runs on one mirror (TUNA, 1.94
  GiB): one `curl` connection at 22.1 MiB/s, four to sixteen engine connections at 55–59 MiB/s. The
  engine's own local ceiling measured 140–280 MiB/s on the same machine, so on that mirror the
  source, not the engine, set the limit — more connections help only until the source saturates, and
  past that they hurt (32 connections measured slower than 16). Re-measuring was attempted and
  abandoned: with a VPN in the path every source fell to 1.5–2.8 MiB/s, which measures the VPN.

## 2.0.0 — the package is renamed to `dsh-download`

**Breaking, and the reason for the major version.** The plugin started life as `dsh-ndm-download`,
when routing large downloads through Neat Download Manager was its whole purpose. The built-in engine
is now the default and NDM is an option, so the old name described the project backwards.

Renamed with it, because they are all the package's identity:

- the client bundle's loader id (`window.__ModuleLoader__.load({ id })` must equal the package name);
- the Cordis row (`tool-ndm-download` → `tool-dsh-download`);
- the read endpoints (`/ndm-download/...` → `/dsh-download/...`);
- the settings and status files (`ndm-download.settings.json` → `dsh-download.settings.json`,
  `ndm-download.status.json` → `dsh-download.status.json`).

**Upgrading an existing installation:** remove the old row first, then install the new one. Running
`uninstall.cmd` from the *old* folder before updating, and `install.cmd` from the new one afterwards,
is enough. The settings and status files can be renamed by hand to keep the existing configuration
and history.

Environment variables keep their `DSH_NDM_*` names, so an existing environment override keeps
working.

### Also in 2.0.0

- **A text file is no longer mistaken for an error page.** The built-in engine refused any response
  that arrived as `text/plain`, `application/json` or XML unless the URL ended in a document
  extension, was offered as an attachment, or was larger than 512 KiB. Source code is exactly the
  shape that rule rejected: an agent trying to fetch `pyinstxtractor.py` was told "the server
  returned text/plain (17.98 KiB), not the file" for a response that was the file — while plain
  `curl` retrieved those same bytes without complaint. The check now refuses a *page* and accepts a
  *file*: `text/html` is refused on the label when the caller did not ask for a document, and any
  other text-shaped response is settled by reading its opening bytes, so a mislabelled interstitial
  page is still refused while a script, config or diff is saved. The extra kilobyte is spent only in
  that ambiguous case, and an inconclusive look accepts rather than refuses.
- **A partial transfer that cannot be resumed is no longer kept.** If no bytes arrived, or the
  resume state is missing or unreadable, the staged file is removed instead of being left in the
  folder wearing the destination's name. A `.part` with no `.part.json` beside it is swept on the
  next start, whatever its age.
- **`partialRetentionDays` (default 7)** — how long a resumable partial may stay before the startup
  sweep removes it. `0` keeps no partial at all: a stopped transfer leaves nothing and cannot be
  resumed. (Read letting zero be a real value, unlike every other numeric setting.)
- **`.ps1` encodings are now verified at package time.** An edit had stripped a BOM, which makes
  PowerShell 5.1 read the file as ANSI. A package-time check now refuses `.ps1` without a BOM,
  `.cmd` that is not ASCII/CRLF, and `.json`/`.js`/`.yml` that carry one.
- **Installer: the folder link is built under a temporary name and swapped in only once it is known
  to work**, with five retries, and both the manifest and the link are rolled back on failure.
  Deleting the working link before creating its replacement once left a profile naming a plugin it
  could not resolve.
- **Installer: `dsh` detection covers more installations** — PATH, `where.exe`, npm's global prefix
  and root, npm's npx cache, pnpm's global root, then the conventional folders — and a failure now
  lists every location it searched. An installation that only ever ran through `npx` is found, with
  a warning that the cache is not an installation.
- **Installer: C-style comments inside error handlers are gone.** `/* … */` parses in PowerShell but
  fails at runtime, so the installer's own failure paths crashed instead of reporting anything.

## 1.0.5 and earlier

- **1.0.5** — installer hardening (above), and the packaging script gained the encoding checks.
- **1.0.4** — installer asks npm for its global locations; `-DshPath` accepts dsh's own `bin.js` as
  well as a shim; the "dsh not found" message lists where it looked.
- **1.0.3** — the installer links the folder itself instead of calling `dsh plugin add`, so
  installing needs neither pnpm nor the network.
- **1.0.2** — bilingual introduction (`INTRODUCTION.md`), `README.txt` for a person who has just
  unzipped the package, and `README.md`'s opening corrected (it still claimed NDM was the default).
- **1.0.1** — reworked installer with a rollback path, and packaging documentation.
- **1.0.0** — the download panel (Settings → Plugins → 下载), read-only status and settings
  endpoints on the host webserver, and the packaging script.

## Earlier, unversioned

- **Resume.** A transfer stages into `<dest>.part` with progress in `<dest>.part.json`, and takes the
  destination name only once every segment is complete; a second call continues where the first one
  stopped. `waitSeconds` became a real bound for the built-in engine, which previously ignored it.
- **The write-path fix.** 16 workers issuing 64 KiB positioned writes measured 1.6 MiB in 48 s on one
  NVMe volume, against 5371 MiB in 45 s with 1 MiB writes — same concurrency, same file. The engine
  now preallocates the destination and coalesces socket chunks into 1 MiB writes. A real 4.44 GiB
  download went from 199 s with a 60-second dead start to 113 s of continuous progress.
- **A completion check that preallocation had made vacuous.** The staged file reaches its final
  length within a second, so "the size is right" proved nothing; every segment's recorded progress is
  now verified before a transfer is called a success.
- **The concurrency gate.** Halving concurrency on a 418/429 changed a variable that nothing read
  after the workers were spawned, so the documented behaviour could never happen. There is now a real
  limit on requests in flight, and a throttled range is retried in place rather than abandoned.
- **The opening probe is retried on 418/429**, instead of aborting a download before a single data
  byte was requested.
- **The status mirror can be restored across a restart** (`restore`), so a panel does not start blank
  after every dsh restart; an entry the previous process still called in-flight is re-recorded as
  interrupted rather than shown as live.
- **`DSH_NDM_STATUS`** redirects the status mirror on its own, which is how the test suites keep the
  history a user's panel shows untouched.
