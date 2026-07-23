# Building & Running Agent Desktop on Windows (x64)

A repeatable process to **build and run this Tauri v2 app from source on Windows x64**
(`x86_64-pc-windows-msvc`). The repo is macOS/Linux-first; this guide fills the Windows gap.

Every version and command below is grounded in what the repo actually specifies. Where a
version is not pinned in the repo, it is called out as **unpinned → use latest stable**.

> **The honest headline (read this first).** `yarn tauri dev` will **not** launch on a fresh
> clone. Tauri's build script (`tauri-build`) refuses to compile until every declared sidecar
> binary and bundled resource **exists on disk** (`src-tauri/tauri.conf.json` lines 42-50), and
> those files are git-ignored (`src-tauri/.gitignore`). You must first either **build the real
> sidecars** (whisper.cpp + llama.cpp from source, ~20 min, needs MSVC + CMake) or **drop
> placeholder files** to launch the UI without voice features. See
> [Sidecars & known Windows gaps](#5-sidecars--known-windows-gaps).

---

## 1. Prerequisites

| Tool | Version | Grounded in |
|---|---|---|
| Rust (rustup) + target `x86_64-pc-windows-msvc` | stable toolchain; MSRV **1.77.2** | `.github/workflows/release.yml:209,393` (`dtolnay/rust-toolchain@stable`, `targets: x86_64-pc-windows-msvc`); `src-tauri/Cargo.toml:9` (`rust-version = "1.77.2"`). No `rust-toolchain.toml` in repo → **unpinned**, use current stable. |
| Node.js | **22** | `release.yml:65,274,376` (`node-version: 22`). No `.nvmrc` in repo → pin locally to 22. |
| Yarn | **Classic / v1** | `README.md:44` ("Yarn (Classic / v1)"); `yarn.lock` present; **no** `packageManager` field in `package.json` → **not** corepack-managed. |
| Visual Studio Build Tools 2022 — "Desktop development with C++" (MSVC v143 + Windows SDK) | **VS 2022** (17) | `release.yml:352` (pins `windows-2022`; `windows-2025`/VS 2026 breaks the sidecar CMake); `scripts/fetch-whisper.sh:117` & `fetch-llama.sh:117` request generator `"Visual Studio 17 2022"`. Also supplies the MSVC linker Rust needs. |
| CMake | unpinned → latest stable | `scripts/fetch-whisper.sh:94`, `fetch-llama.sh:94` require `git` + `cmake` on PATH. |
| Git for Windows (**Git Bash**) | latest stable | The `scripts/*.sh` provisioners are POSIX bash and only run under Git Bash on Windows (`src-tauri/binaries/README.md:37-40`). |
| WebView2 Runtime | ships with Windows 11 | `src-tauri/tauri.conf.json:61-64` (`webviewInstallMode: downloadBootstrapper` — that's the *installer* path; the dev shell needs the runtime already present, which Win 11 has). |
| Python | **not required** | No `.python-version` in repo; no provisioning script uses Python. |

### Install commands (PowerShell, no admin required for winget user-scope)

```powershell
# Rust toolchain + the Windows MSVC target
winget install --id Rustlang.Rustup -e
rustup default stable
rustup target add x86_64-pc-windows-msvc

# Node 22 — pick ONE:
winget install --id CoreyButler.NVMforWindows -e   # then: nvm install 22 ; nvm use 22
# or:  winget install --id OpenJS.NodeJS.LTS -e     # (verify it installs the 22.x line)

# Enable Yarn Classic (v1). Corepack ships with Node:
corepack enable
npm install --global yarn         # alternative if you prefer not to use corepack; installs Yarn v1

# CMake + Git (Git Bash)
winget install --id Kitware.CMake -e
winget install --id Git.Git -e

# Visual Studio 2022 Build Tools with the C++ workload (large download)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

After installing, open a **fresh** terminal so PATH updates take effect. Verify:
`rustc --version`, `rustup target list --installed` (should list `x86_64-pc-windows-msvc`),
`node --version` (v22.x), `yarn --version` (1.x), `cmake --version`.

---

## 2. First-time setup

```powershell
cd C:\Code\agent-desktop
yarn install            # release.yml uses `yarn install --frozen-lockfile`
```

`yarn install` runs a `postinstall` that only sets the git hooks path (`package.json:10`) — harmless.

> **Do NOT run `yarn setup`.** That script (`package.json:7-9`) chains `setup:sidecars`, which
> invokes the three POSIX `./scripts/*.sh` provisioners — they only work from **Git Bash**, not
> PowerShell. Handle sidecars explicitly per [section 5](#5-sidecars--known-windows-gaps).

---

## 3. Run in dev

```powershell
yarn tauri dev
```

- The `beforeDevCommand` is `npm run dev:web` (`tauri.conf.json:9`) — note it invokes **npm**, not
  yarn; npm ships with Node so this just works. It starts Vite on `http://localhost:1420`
  (`tauri.conf.json:8`) and Tauri loads that.
- **This only compiles once the sidecar + resource files exist** (see the headline note and
  section 5). On a fresh clone it fails during `tauri-build` with a missing-`externalBin` error
  until you provision or stub them.

---

## 4. Build a release (local, unsigned)

```powershell
yarn build
```

`yarn build` maps to `tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`
(`package.json:12`), which disables updater artifacts so **no signing key is required** locally
(`README.md:105-106`). `beforeBuildCommand` is `npm run build:web` (`tauri.conf.json:10`).

Unlike `cargo check`, a real build **links and bundles**, so it needs the **real** sidecar
binaries and the real bundled model — placeholders are not enough here. Installers land in
`src-tauri\target\x86_64-pc-windows-msvc\release\bundle\{msi,nsis}\` (per `release.yml:332-333`).

> Signing/notarization is **CI-only** — there is no local signed-build path (`README.md:78-79`).

---

## 5. Sidecars & known Windows gaps

### What the app expects at runtime

`src-tauri/tauri.conf.json:42-50` declares three sidecar binaries and two bundled resources:

| File | Purpose | Needed for |
|---|---|---|
| `binaries/whisper-cli-x86_64-pc-windows-msvc.exe` | whisper.cpp one-shot final transcription | Voice dictation (final pass) |
| `binaries/whisper-server-x86_64-pc-windows-msvc.exe` | whisper.cpp resident server | Voice dictation (live partials) |
| `binaries/llama-server-x86_64-pc-windows-msvc.exe` | llama.cpp OpenAI-compatible server | Transcript polish |
| `models/ggml-tiny.bin` | bundled tiny whisper model (~75 MB) | Voice transcription weights |
| `resources/orchestration-mcp.cjs` | orchestrator MCP script | Agent orchestration — **already committed**, no action needed |

The three `.exe` sidecars and `ggml-tiny.bin` are **git-ignored** (`src-tauri/.gitignore:6-18`)
and **absent on a fresh clone**. There are **no committed Windows placeholders** — the repo only
ships shell-script placeholders for `aarch64-apple-darwin` (`binaries/README.md:125-130`).

### The crux: does `yarn tauri dev` launch a usable app on Windows as-is? No.

Two separate walls:

1. **Compile wall (blocks any launch).** `tauri-build` validates that every `externalBin` and
   resource *exists* before the Rust crate compiles (`release.yml:225-226`;
   `scripts/check-windows.sh:71-74`). Missing files → the build fails and nothing launches.
2. **Runtime wall (blocks voice only).** The three sidecars are the voice/polish engines. The core
   app — terminals, projects, git integration, the orchestration MCP — needs **none** of them, and
   the sidecars are started **lazily** (only when you invoke voice). So a launched app with stub
   sidecars is fully usable *except* voice dictation and transcript polish.

### About the CI `printf 'MZ' > ...` trick — it is a COMPILE hack, not a runnable binary

CI's `windows-check` job writes a 2-byte file (`printf 'MZ' > src-tauri/binaries/<name>-x86_64-pc-windows-msvc.exe`,
`release.yml:227-234`) purely so `cargo check` — which **does not link** — passes the existence
check. That 2-byte stub is **not an executable**; it exists only because real sidecars take ~20 min
to build and none of their bytes affect type-checking (`release.yml:196-201`). **Do not expect it to
run.** It is enough to *launch the UI* (sidecars are lazy), but any voice action will fail.

### Realistic paths to a running app

**A. UI-only launch (fast — everything except voice).** From **Git Bash**, drop stubs so the
compile wall passes, then run dev from PowerShell:

```bash
# Git Bash, from repo root
mkdir -p src-tauri/binaries src-tauri/models
for n in whisper-cli whisper-server llama-server; do
  printf 'MZ' > "src-tauri/binaries/$n-x86_64-pc-windows-msvc.exe"
done
: > src-tauri/models/ggml-tiny.bin
```

Then `yarn tauri dev` in PowerShell launches the full UI. Voice dictation and polish are
non-functional (they invoke a non-runnable stub) — acceptable if you're working on terminals,
projects, git, or orchestration.

**B. Full features (slow — real sidecars).** From **Git Bash**, with MSVC + CMake installed, run
the provisioners for the Windows target. They clone and build whisper.cpp (`WHISPER_TAG=v1.7.4`)
and llama.cpp (`LLAMA_TAG=b4000`) from source via the "Visual Studio 17 2022" generator
(`release.yml:43-44`; `fetch-whisper.sh:117`; `fetch-llama.sh:117`):

```bash
# Git Bash, from repo root — ~20 min, needs network + MSVC + CMake
export TARGET_TRIPLE=x86_64-pc-windows-msvc
./scripts/fetch-models.sh      # downloads ggml-tiny.bin (~75 MB)
./scripts/fetch-whisper.sh     # builds whisper-cli + whisper-server .exe
./scripts/fetch-llama.sh       # builds llama-server .exe (auto-patches <chrono> for MSVC)
./scripts/validate-sidecars.sh # asserts PE32+ x86-64 format for each
```

`fetch-llama.sh:137-143` automatically prepends `#include <chrono>` to llama.cpp@b4000 sources
because VS 2022's newer MSVC STL no longer provides it transitively — no manual patch needed.
After this, `yarn tauri dev` and `yarn build` both work with full voice support.

> Note: additional larger voice models (small / large-v3-turbo) and the polish GGUF are downloaded
> to app-data **at runtime** by the app, not bundled (`fetch-models.sh:15-18`; `binaries/README.md:89-93,159-165`).

### Optional: type-check for Windows without a full build

`scripts/check-windows.sh` runs `cargo check --target x86_64-pc-windows-msvc` and is meant for
macOS/Linux (it uses `cargo-xwin`). On Windows you can check directly once stubs exist:

```powershell
cd src-tauri
cargo check --target x86_64-pc-windows-msvc --all-targets
```

---

## 6. Troubleshooting

- **`tauri dev`/`build` fails with a missing `externalBin` / resource.** The sidecar `.exe`s or
  `models/ggml-tiny.bin` aren't on disk. Apply path **A** or **B** in section 5.
- **Voice dictation / polish does nothing or errors, but the app runs.** You launched with stub
  sidecars (path A). Build the real ones (path B).
- **`yarn setup` errors in PowerShell (`./scripts/...` not found / not executable).** Those are
  POSIX shell scripts — run the provisioners from **Git Bash**, not PowerShell (section 5B). Skip
  `yarn setup` on Windows; use `yarn install` + explicit sidecar provisioning.
- **CMake: "could not find any instance of Visual Studio".** Install the **VS 2022** "Desktop
  development with C++" workload. The scripts hard-code the `"Visual Studio 17 2022"` generator;
  VS 2026 (from `windows-2025`) is explicitly unsupported for the sidecars (`release.yml:349-352`).
- **`cargo` errors like "can't find crate for `core`".** The MSVC target isn't installed:
  `rustup target add x86_64-pc-windows-msvc`.
- **Linker (`link.exe`) not found.** The MSVC C++ toolchain (VS Build Tools "Desktop development
  with C++") isn't installed or the terminal predates its PATH update — reopen the terminal.
- **Line endings.** These scripts are LF POSIX shell; run them in Git Bash and avoid a global
  `core.autocrlf=true` mangling `scripts/*.sh` or the `resources/*.cjs`.
- **`yarn install` blocked / lockfile drift.** CI uses `yarn install --frozen-lockfile`
  (`release.yml:302`); match it to catch lockfile issues early.

---

### Quick reference — the three commands

```powershell
yarn install      # install JS deps (CI: --frozen-lockfile)
yarn tauri dev    # run in dev (needs sidecar stubs OR real sidecars first — section 5)
yarn build        # local unsigned release build (updater artifacts disabled)
```
