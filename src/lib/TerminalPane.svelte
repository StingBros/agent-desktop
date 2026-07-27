<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Terminal, IDisposable } from '@xterm/xterm';
  import type { FitAddon } from '@xterm/addon-fit';
  import type { WebglAddon } from '@xterm/addon-webgl';
  import { Channel, invoke } from '@tauri-apps/api/core';
  import { registerTerminal, unregisterTerminal } from './layout/terminals';
  import { dropTarget } from './layout/dropTarget.svelte';
  import { fileLinkAt, urlAt } from './terminalLinks';
  import { lineEditSeq } from './terminalKeys';
  import { openWith } from './settings/openWith.svelte';
  import { getUsagePaths } from './usage/paths';
  import { buildSpawnOverride } from './usage/spawn';
  import {
    InitialInputSender,
    initialInputForMount,
    LaunchPromptReadiness,
    SUBMIT_DELAY_MS,
    READY_MAX_MS
  } from './launcher/initialInput';
  import { LaunchSpinner, spinnerLabel } from './launcher/spinner';
  import { noteOutput, noteExit, noteBusy, noteResize, clearRuntime } from './overview/runtime';
  import { detectTerminalBusy } from './overview/terminalBusy';
  import { events } from './overview/events.svelte';
  import { executor } from './orchestration/executor.svelte';

  // PtyEvent — the exact wire shape the Rust backend streams over the per-pane
  // Channel (internally tagged on `event`):
  //   { event: 'data', bytes: number[] }  -> raw output bytes (write to xterm)
  //   { event: 'exit', code: number }     -> child exited and was reaped
  type PtyEvent =
    | { event: 'data'; bytes: number[] }
    | { event: 'exit'; code: number };

  let {
    /** Stable identity for this pane. Caller keys usage on it (`{#key paneId}`). */
    paneId,
    /** Program to run in the PTY. Defaults to `claude`. */
    program = 'claude',
    /** Arguments passed to the program. */
    args = [] as string[],
    /** Working directory for the child; `null` inherits the app's cwd. */
    cwd = null as string | null,
    /**
     * Whether this pane is the focused/active one. Browsers cap WebGL contexts
     * (~16/page), so we load the WebGL renderer ONLY on the active pane and
     * dispose it on inactive ones (xterm falls through to its DOM renderer,
     * preserving scrollback). See design D5.
     */
    active = true,
    /**
     * While true, `fit()` is deferred (a gutter drag is in progress). When it
     * flips back to false we run one fit to settle the final geometry. This
     * avoids reflow/PTY-resize churn on every drag frame (spec: defer fit to
     * drag-end).
     */
    deferFit = false,
    /**
     * Whether this pane's workspace is currently shown. Hidden workspaces are
     * `display:none` (host is 0×0), so we MUST re-fit when a pane becomes
     * visible again — its container may have changed size while hidden. Default
     * true so single-workspace callers are unaffected. (Spec: re-fit the active
     * workspace panes on switch.)
     */
    visible = true,
    /**
     * OPTIONAL user-supplied initial prompt (session-launcher spec). After the
     * PTY is spawned and the input/output wiring is live, this text is written
     * to the PTY VERBATIM followed by a single carriage return, exactly ONCE
     * (guarded against double-send on re-render via `InitialInputSender`).
     * Empty/undefined sends nothing — `claude` starts at an idle prompt. The app
     * NEVER synthesizes a slash command; a prompt beginning with `/` is passed
     * through verbatim. See src/lib/launcher/initialInput.ts.
     */
    initialInput = undefined as string | undefined,
    /**
     * OPTIONAL app-owned Claude session id (claude panes only). Injected as
     * `--session-id <id>` (fresh) or `--resume <id>` (when resume is true) so the
     * overview can locate this exact agent's transcript.
     */
    sessionId = undefined as string | undefined,
    /**
     * When true, the pane was restored from a prior saved session and will use
     * `--resume <sessionId>` so claude continues from its prior transcript.
     * Absent (false/undefined) for fresh launches and splits.
     */
    resume = undefined as boolean | undefined,
    /**
     * OPTIONAL callback fired when the child process exits on its own (PTY EOF),
     * with its exit code. Used by the Terminals panel to flip a terminal slot to
     * stopped (and record the exit code) without removing it. Not used by agent
     * panes (the overview reads exits from the activity pipeline instead).
     */
    onExit = undefined as ((code: number) => void) | undefined,
    /**
     * OPTIONAL callback fired when the terminal's title changes (xterm
     * `onTitleChange`, i.e. an OSC 0/2 sequence). Used by the Terminals panel to
     * label a terminal with the actively running command. Agent panes pass none.
     */
    onTitle = undefined as ((title: string) => void) | undefined
  }: {
    paneId: string;
    program?: string;
    args?: string[];
    cwd?: string | null;
    active?: boolean;
    deferFit?: boolean;
    visible?: boolean;
    initialInput?: string;
    sessionId?: string;
    resume?: boolean;
    onExit?: (code: number) => void;
    onTitle?: (title: string) => void;
  } = $props();

  // Single-shot sender for the optional initial prompt. Constructed in onMount
  // from the LAUNCH-TIME prop value (an initial prompt is delivered once, at
  // spawn — never re-sent on a later prop change); `trySend` is idempotent across
  // re-renders so the prompt is delivered at most once (guard against
  // double-send). The app never synthesizes a command — only the user's text.
  let initialInputSender: InitialInputSender | undefined;
  // Gates initial-prompt delivery on the TUI being ready (output seen, then
  // quiet). Component-scoped so teardown can cancel its pending timers.
  let readiness: LaunchPromptReadiness | undefined;
  // Launch-spinner readiness backstop: clears the overlay even if a promptless
  // pane spawns but emits no output and never exits (the prompt-bearing path is
  // already capped by maxTimer). Component-scoped so teardown can clear it.
  let spinnerCapTimer: ReturnType<typeof setTimeout> | undefined;

  // The host element xterm renders into.
  let host: HTMLDivElement;

  // Live resources, owned by this component instance. All created in onMount,
  // all released (in order) in onDestroy. Kept as plain (non-reactive) locals so
  // xterm is never constructed/read inside a state-tracking $effect.
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let webgl: WebglAddon | undefined;
  let channel: Channel<PtyEvent> | undefined;
  let ro: ResizeObserver | undefined;
  let onDataSub: IDisposable | undefined;
  let onResizeSub: IDisposable | undefined;
  let onTitleSub: IDisposable | undefined;
  let contextLossSub: IDisposable | undefined;

  // ── File / URL links (terminal-file-links spec) ─────────────────────────
  // ⌘-hover over a token that resolves to an existing path — or an http(s) URL →
  // dotted underline + pointer; ⌘-click → open it (per the user's open-with
  // preferences; URLs use the HTML/browser preference). We manage
  // the affordance OURSELVES (own overlay + cursor class + capture-phase click)
  // rather than via xterm's link provider: the provider's hover/cursor fights the
  // PTY mouse-reporting that claude's TUI enables (`.xterm.enable-mouse-events`
  // forces the default cursor) and its async hit-testing made the underline/cursor
  // flicker. Self-managing gives a stable underline + pointer that persist at rest.
  // The DOM overlay drawing the dotted underline (child of `host`).
  let underlineEl: HTMLDivElement | undefined;
  // Whether ⌘ (Meta) is currently held; gates the whole affordance.
  let metaDown = false;
  // Last pointer position over the host (client coords), so ⌘ press/release can
  // re-evaluate the hover without waiting for a mouse move.
  let lastPointer: { clientX: number; clientY: number } | undefined;
  // The resolved absolute path currently armed under the pointer (⌘ held), or null.
  let armedPath: string | null = null;
  // Identity of the armed token (`absLine:start:text`) to skip redundant re-resolves
  // while the pointer moves within the same token.
  let armedKey: string | null = null;
  // Monotonic counter so a slow `resolve_path` reply that arrives after the pointer
  // moved on is ignored (only the latest hover wins).
  let resolveSeq = 0;
  // Window/host listeners owned by this instance (removed in onDestroy).
  let onKeyDown: ((e: KeyboardEvent) => void) | undefined;
  let onKeyUp: ((e: KeyboardEvent) => void) | undefined;
  let onWinBlur: (() => void) | undefined;
  let onHostMove: ((e: MouseEvent) => void) | undefined;
  let onHostLeave: (() => void) | undefined;
  let onHostDownCapture: ((e: MouseEvent) => void) | undefined;
  let onTermScroll: IDisposable | undefined;

  // The backend pane id (u64) for this terminal, resolved by pty_spawn. Distinct
  // from the frontend `paneId` identity prop.
  let ptyId: number | undefined;
  // Reactive: surfaced on the host as `data-exited` for styling/tests.
  let exited = $state(false);

  // Launch spinner: while an agent pane is spinning up (or resuming) we overlay a
  // centered spinner + label so the user never sees a blank pane or a
  // half-rendered TUI. `spinner` (the LaunchSpinner model) owns the readiness
  // rules; `loading` mirrors `spinner.loading` into reactive state at the
  // output/inject/exit sites that already drive this component. Both are
  // initialized in onMount from the LAUNCH-TIME props (like `initialInputSender`),
  // so the spinner is a spawn-time concern that never re-derives on a prop change.
  let spinner: LaunchSpinner | undefined;
  let loading = $state(false);
  let loadingLabel = $state('Starting…');
  // True once `term.open()` has run, so the WebGL effect knows the renderer is
  // attachable. Plain local (not state): only read inside async/effect bodies.
  let opened = false;

  // GitHub-ish dark theme. Note: the xterm 6 key is `selectionBackground`
  // (the old `selection` key was removed).
  const THEME = {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#284766',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  };

  /** Guarded fit: skip 0×0 containers (hidden / mid-layout) so we never push a
   *  zero-size resize down to the PTY, and skip entirely while a gutter drag is
   *  in progress (deferFit) — the final fit runs at drag-end. Returns whether a
   *  fit ran. */
  function safeFit(): boolean {
    if (!fit || !host) return false;
    if (deferFit) return false;
    if (host.clientWidth === 0 || host.clientHeight === 0) return false;
    fit.fit();
    return true;
  }

  /** Append a subtle inline note (used for `[process exited]`). */
  function note(text: string) {
    // Dim grey, on its own line, without disturbing scrollback semantics.
    term?.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
  }

  // WebGL is loaded lazily and ONLY on the active pane (context cap ~16/page).
  // These two helpers are idempotent so the `active` effect can call them
  // freely. On context loss we dispose and let xterm's DOM renderer take over.
  async function loadWebgl() {
    if (webgl || !term || !opened) return;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      // The term may have been disposed (or we lost focus) while awaiting. The
      // `!active` re-check is load-bearing: WebGL contexts are capped (~16/page), so
      // attaching one to a pane that went inactive during the dynamic import would
      // pin a context on an off-screen pane and starve the genuinely-active one.
      if (!term || !opened || webgl || !active) return;
      const addon = new WebglAddon();
      contextLossSub = addon.onContextLoss(() => {
        addon.dispose();
        if (webgl === addon) webgl = undefined;
        // term keeps rendering via the DOM renderer; scrollback is preserved.
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      // No WebGL available — DOM renderer is already active. Not fatal.
      webgl = undefined;
    }
  }

  function disposeWebgl() {
    contextLossSub?.dispose();
    contextLossSub = undefined;
    webgl?.dispose();
    webgl = undefined;
    // xterm transparently falls back to the DOM renderer; scrollback + the live
    // PTY are untouched (we only swap the renderer, never the Terminal).
  }

  // Drop the armed state: hide the underline overlay and revert the cursor.
  function clearArmed() {
    armedPath = null;
    armedKey = null;
    if (underlineEl) underlineEl.style.display = 'none';
    host?.querySelector('.xterm-screen')?.classList.remove('file-link-armed');
  }

  // Cell geometry from the live screen element. xterm fills `.xterm-screen` with an
  // exact cols×rows grid, so cell size = screenRect / (cols|rows) — accurate enough
  // for hit-testing tokens and positioning the underline.
  function screenMetrics() {
    if (!term || !host) return undefined;
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return undefined;
    const rect = screen.getBoundingClientRect();
    const { cols, rows } = term;
    if (!cols || !rows || rect.width === 0 || rect.height === 0) return undefined;
    return { screen, rect, cellW: rect.width / cols, cellH: rect.height / rows };
  }

  // How many lines from the BOTTOM of the live buffer to scan for the active-work
  // affordance. Claude renders its running-spinner / "Waiting for N dynamic
  // workflow(s)" line at/near the bottom of the viewport, so a small tail is both
  // sufficient and cheap (no full-scrollback scan on every output chunk).
  const BUSY_SCAN_LINES = 40;

  /**
   * A bounded tail of the live terminal text (the last `BUSY_SCAN_LINES` rendered
   * lines), joined with newlines. Reads xterm's active buffer directly — the same
   * `getLine().translateToString()` path the file-link hit-test uses. Returns ''
   * when the terminal isn't ready. Used ONLY to feed `detectTerminalBusy`.
   */
  function recentTerminalText(): string {
    if (!term) return '';
    const buf = term.buffer.active;
    // `baseY + rows` is one past the last viewport row; scan the tail up to there.
    const end = buf.baseY + term.rows;
    const start = Math.max(0, end - BUSY_SCAN_LINES);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i)?.translateToString(true);
      if (line) lines.push(line);
    }
    return lines.join('\n');
  }

  // Re-evaluate the hover at `lastPointer`: when ⌘ is held and the pointer sits on a
  // token that `resolve_path` confirms exists, arm it (underline + pointer cursor +
  // store the absolute path for ⌘-click). Otherwise clear. Async-safe via resolveSeq.
  async function updateHover() {
    if (!metaDown || !lastPointer || !term) {
      clearArmed();
      return;
    }
    const mx = screenMetrics();
    if (!mx) {
      clearArmed();
      return;
    }
    const { rect, cellW, cellH } = mx;
    const relX = lastPointer.clientX - rect.left;
    const relY = lastPointer.clientY - rect.top;
    if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) {
      clearArmed();
      return;
    }
    const col = Math.floor(relX / cellW);
    const viewportRow = Math.floor(relY / cellH);
    const absLine = term.buffer.active.viewportY + viewportRow;
    const lineText = term.buffer.active.getLine(absLine)?.translateToString(true);
    if (!lineText) {
      clearArmed();
      return;
    }
    // HTTP/HTTPS URLs are linkified directly — no filesystem resolution. Check
    // this BEFORE the file path so a URL like `http://localhost:3000` is armed as
    // a URL (and isn't mangled by the file token's `:port`→`:line` stripping).
    const url = urlAt(lineText, col);
    if (url) {
      const urlKey = `url:${absLine}:${url.start}:${url.text}`;
      // Same URL already armed — position is stable, nothing to redo.
      if (urlKey === armedKey && armedPath) return;
      // Invalidate any in-flight `resolve_path` so its late reply can't clobber
      // this synchronous URL arm.
      resolveSeq++;
      armedPath = url.text;
      armedKey = urlKey;
      positionUnderline(mx, viewportRow, url.start, url.end);
      mx.screen.classList.add('file-link-armed');
      return;
    }

    const link = fileLinkAt(lineText, col);
    if (!link) {
      clearArmed();
      return;
    }
    const key = `${absLine}:${link.start}:${link.text}`;
    // Same token we already armed — nothing to re-resolve (position is stable).
    if (key === armedKey && armedPath) return;
    const seq = ++resolveSeq;
    const abs = await invoke<string | null>('resolve_path', { cwd, token: link.text }).catch(
      () => null
    );
    // Superseded by a newer hover, or ⌘ released, or not a real path → bail/clear.
    if (seq !== resolveSeq) return;
    if (!metaDown || !abs) {
      clearArmed();
      return;
    }
    armedPath = abs;
    armedKey = key;
    positionUnderline(mx, viewportRow, link.start, link.end);
    mx.screen.classList.add('file-link-armed');
  }

  // Place the dotted-underline overlay over the token's cells. The overlay is a
  // child of `host`, so we position it in host-local coords (screen offset + cell).
  function positionUnderline(
    mx: NonNullable<ReturnType<typeof screenMetrics>>,
    viewportRow: number,
    startCol: number,
    endCol: number
  ) {
    if (!underlineEl || !host) return;
    const hostRect = host.getBoundingClientRect();
    const offX = mx.rect.left - hostRect.left;
    const offY = mx.rect.top - hostRect.top;
    underlineEl.style.left = `${offX + startCol * mx.cellW}px`;
    underlineEl.style.top = `${offY + (viewportRow + 1) * mx.cellH - 2}px`;
    underlineEl.style.width = `${(endCol - startCol) * mx.cellW}px`;
    underlineEl.style.display = 'block';
  }

  // Wire the ⌘-gated file-link affordance: ⌘/pointer tracking, hover evaluation,
  // and capture-phase ⌘-click to open. Everything is torn down in onDestroy.
  function setupFileLinks(t: Terminal) {
    const setMeta = (down: boolean) => {
      if (down === metaDown) return;
      metaDown = down;
      if (down) void updateHover();
      else clearArmed();
    };
    onKeyDown = (e) => {
      if (e.key === 'Meta') setMeta(true);
    };
    onKeyUp = (e) => {
      if (e.key === 'Meta') setMeta(false);
    };
    onWinBlur = () => setMeta(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWinBlur);

    onHostMove = (e) => {
      lastPointer = { clientX: e.clientX, clientY: e.clientY };
      if (metaDown) void updateHover();
    };
    onHostLeave = () => {
      lastPointer = undefined;
      clearArmed();
    };
    host.addEventListener('mousemove', onHostMove);
    host.addEventListener('mouseleave', onHostLeave);

    // ⌘-click → open the armed path. Capture phase on `host` runs before xterm's
    // own mouse handlers (bound on descendants), and stopImmediatePropagation keeps
    // the click from starting a selection or being reported to the PTY.
    onHostDownCapture = (e) => {
      if (e.button !== 0 || !metaDown || !armedPath) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Pass the pane cwd (the agent's working dir = project root) so a
      // workspace-capable editor opens the project and reveals the file within
      // it, rather than guessing a workspace from the file's folder. A URL arm
      // (cwd irrelevant) falls in a non-editor bucket and ignores the root.
      void openWith.openFile(armedPath, cwd);
    };
    host.addEventListener('mousedown', onHostDownCapture, true);

    // Scrolling moves the buffer under a stationary pointer; drop the (now stale)
    // affordance — it re-arms on the next move.
    onTermScroll = t.onScroll(() => clearArmed());
  }

  onMount(() => {
    let disposed = false;

    // Capture the launch-time initial prompt once (an initial prompt is a
    // spawn-time value; later prop changes must not re-send it). A RESUMED pane
    // (archive→restore / preview re-mounts this component with the registry's
    // initialInput still set) must NOT re-send the launch prompt — its transcript
    // already has it — so the prompt is gated on `resume` here.
    initialInputSender = new InitialInputSender(initialInputForMount(initialInput, resume));

    // Arm the launch spinner from the same launch-time values: agent panes
    // (claude) show it; a prompt-bearing pane holds it until the prompt lands.
    spinner = new LaunchSpinner({
      isAgent: program === 'claude',
      hasPrompt: initialInputSender.hasPrompt
    });
    loading = spinner.loading;
    loadingLabel = spinnerLabel(resume);
    // Backstop: never leave the (opaque) overlay covering a live pane forever.
    // Clears the spinner after the same cap used for prompt delivery, in case the
    // pane never emits output and never exits.
    if (loading) {
      spinnerCapTimer = setTimeout(() => {
        spinner?.onTimeout();
        loading = spinner?.loading ?? false;
      }, READY_MAX_MS);
    }

    // Initial-prompt delivery waits for claude's startup output to go QUIET — the
    // TUI emits a burst of setup/render output on launch and is NOT yet accepting
    // input during it; writing then left the text garbled and the Enter swallowed
    // (the "work never starts, shows as needs attention" symptom). The readiness
    // gate (constructed below, once the sender is known to carry a prompt) only
    // begins its quiet window AFTER the first output byte — so a slow startup that
    // stays silent past the window (e.g. a coordinated agent loading the MCP
    // toolkit) can't deliver into a TUI that hasn't started rendering. Once output
    // settles (or a hard cap fires) we write the verbatim text, then the
    // submitting Enter as a SEPARATE write after a settle. Delivered at most once.
    const deliverInitial = () => {
      // Defensive: the gate only fires after `wired()`, but never write to a PTY
      // that isn't (or is no longer) live.
      if (ptyId === undefined) return;
      initialInputSender?.deliver(
        (data) => {
          if (ptyId === undefined) return;
          void invoke('pty_write', { id: ptyId, data }).catch(() => {});
        },
        (run) => setTimeout(run, SUBMIT_DELAY_MS)
      );
      // The prompt is being injected (or the readiness cap fired) — drop the
      // launch spinner now that the agent's starting text has landed.
      spinner?.onInjected();
      loading = spinner?.loading ?? false;
    };

    if (initialInputSender.hasPrompt) {
      readiness = new LaunchPromptReadiness(
        deliverInitial,
        (run, ms) => setTimeout(run, ms),
        (h) => clearTimeout(h)
      );
    }

    (async () => {
      // Dynamic-import the heavy/DOM-only modules so SSR + the static build stay
      // clean (these touch `window`/WebGL and must not run at build time).
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit')
      ]);

      // The component may have been torn down while we were awaiting imports.
      if (disposed) return;

      term = new Terminal({
        allowProposedApi: true,
        scrollback: 5000,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        theme: THEME,
        cursorBlink: true
      });

      fit = new FitAddon();
      term.loadAddon(fit);

      // Open into the DOM *before* loading WebGL — the WebGL addon needs a live
      // renderer/canvas to attach to.
      term.open(host);
      opened = true;
      safeFit();

      // Wire ⌘-hover/click file links now the terminal is in the DOM (the link
      // provider reads `host`'s xterm children and the pane's `cwd`).
      setupFileLinks(term);

      // WebGL renderer — loaded ONLY when this pane is active (context cap
      // ~16/page). The reactive `active` effect below keeps this in sync as
      // focus moves; here we just kick off the initial load if we start active.
      // We never use @xterm/addon-canvas (removed in xterm 6); the fallback is
      // xterm's own DOM renderer.
      if (active && !disposed) await loadWebgl();

      // Per-pane output channel. The backend streams PtyEvents here in read order.
      channel = new Channel<PtyEvent>();
      channel.onmessage = (msg) => {
        if (!term) return;
        if (msg.event === 'data') {
          // Raw bytes, verbatim — xterm reassembles split codepoints / escapes.
          term.write(new Uint8Array(msg.bytes));
          // Record PTY activity for the agent-overview status (working vs waiting)
          // and, on the first byte, deliver any pending initial prompt now that
          // claude's TUI has begun rendering.
          noteOutput(paneId, Date.now());
          // Re-detect the "actively working" affordance from the live terminal tail
          // (a foreground command running, or in-session background work) — the
          // event hooks miss these, so the roster reads it via `runtime.terminalBusyAt`
          // to keep the agent In flight rather than Needs input. Pass the current time:
          // a POSITIVE detection stamps the timestamp; `rowFor` holds In flight while it
          // is within `BUSY_GRACE_MS`, so the redrawing spinner's per-chunk flicker (and
          // the 1 s heartbeat sampling) does not bounce the row. `term.write` above is
          // async; reading the buffer now reflects the PRIOR frame (at worst a one-chunk
          // lag), which the grace window also absorbs.
          noteBusy(paneId, detectTerminalBusy(recentTerminalText()), Date.now());
          // First/each output byte (re)starts the readiness quiet window; the
          // gate delivers the initial prompt once output settles (TUI ready).
          readiness?.noteOutput();
          // First output means the TUI is rendering — clear the launch spinner
          // for a promptless/resumed pane (a prompt-bearing pane stays covered
          // until the prompt is injected; see deliverInitial).
          spinner?.onOutput();
          loading = spinner?.loading ?? false;
        } else {
          exited = true;
          // Record the exit for the overview status (finished vs errored, by code).
          noteExit(paneId, msg.code);
          // LOST-ASSIGNEE RECONCILIATION (task group 5 wiring): a dying worker fails
          // any non-terminal Task assigned to it (never completes it — completion is
          // report_done only). Called here, while the pane is still registered, so the
          // executor (the single Task writer) can resolve the pane's project via
          // `locate`. Idempotent + best-effort for panes with no assigned Task.
          executor.reconcileOnPaneExit(paneId);
          // Clear the backend pane id so input/paste/send (and the registered
          // `send` handle) all treat this pane as dead: nothing is written to a
          // PTY that no longer exists, and `send` reports false rather than a
          // false success.
          ptyId = undefined;
          // A child that exits before becoming ready must not spin forever.
          spinner?.onExit();
          loading = spinner?.loading ?? false;
          note(`[process exited${msg.code !== 0 ? ` (code ${msg.code})` : ''}]`);
          // Surface the exit to an interested parent (Terminals panel) so the slot
          // flips to stopped + records the code. Agent panes pass no callback.
          onExit?.(msg.code);
        }
      };

      // Wire `claude` panes THROUGH the statusline wrapper (per-session
      // `--settings` override + AGENT_DESKTOP_PANE/SNAPSHOT_DIR env), leaving the
      // global ~/.claude/settings.json untouched. Shell panes spawn unchanged.
      // `getUsagePaths()` is memoized (one round-trip across all panes) and
      // resolves to null on failure, in which case `claude` spawns unwrapped.
      const usagePaths = program === 'claude' ? await getUsagePaths() : null;
      if (disposed) return;
      const { args: spawnArgs, env: spawnEnv } = buildSpawnOverride({
        program,
        args,
        paneId,
        sessionId,
        resume,
        usagePaths
      });

      // Spawn the PTY-backed process. Arg name `onEvent` is the camelCase of the
      // Rust param `on_event`; the command name stays verbatim. `env` is omitted
      // for shell panes (undefined → backend default empty), set only for claude.
      const id = await invoke<number>('pty_spawn', {
        program,
        args: spawnArgs,
        cwd,
        cols: term.cols,
        rows: term.rows,
        env: spawnEnv,
        onEvent: channel
      });
      if (disposed) {
        // Torn down mid-spawn: kill the freshly-spawned child so it isn't orphaned.
        void invoke('pty_kill', { id }).catch(() => {});
        return;
      }
      ptyId = id;
      // PTY wired: arm the readiness hard-cap backstop now. The quiet window only
      // starts once output is seen (handled in the data channel above), so a slow
      // startup that stays silent can't deliver the prompt prematurely.
      readiness?.wired();

      // Expose a Copy/Paste handle for the pane context menu (decoupled from the
      // xterm instance). Unregistered in onDestroy.
      registerTerminal(paneId, {
        getSelection: () => term?.getSelection() ?? '',
        hasSelection: () => term?.hasSelection() ?? false,
        paste: (text: string) => {
          if (ptyId === undefined || !text) return;
          void invoke('pty_write', {
            id: ptyId,
            data: Array.from(new TextEncoder().encode(text))
          }).catch(() => {});
        },
        // Message-an-agent (agent-overview): write the EXACT user text plus a
        // single carriage return through the same pty_write path. Sends ONLY the
        // given text — nothing is synthesized on the user's behalf. Returns false
        // when there is no live PTY to write to (the process exited / never wired),
        // so the caller never reports a false success against a dead agent.
        send: (text: string): boolean => {
          if (ptyId === undefined) return false;
          void invoke('pty_write', {
            id: ptyId,
            data: Array.from(new TextEncoder().encode(text + '\r'))
          }).catch(() => {});
          return true;
        },
        // Answer-an-interactive-menu (agent-overview): write raw bytes VERBATIM
        // (arrow/Enter sequences) to the live TUI, with no appended carriage return.
        // Returns false when there is no live PTY to write to.
        sendKeys: (data: string): boolean => {
          if (ptyId === undefined || !data) return false;
          void invoke('pty_write', {
            id: ptyId,
            data: Array.from(new TextEncoder().encode(data))
          }).catch(() => {});
          return true;
        },
        // Inbox: focus this pane's xterm so typing goes straight to the PTY, and
        // pin the viewport to the live prompt on entry.
        focus: () => {
          term?.focus();
        },
        scrollToBottom: () => {
          term?.scrollToBottom();
        }
      });

      // Input: forward raw encoded bytes to the PTY writer.
      const enc = new TextEncoder();
      onDataSub = term.onData((d) => {
        if (ptyId === undefined) return;
        void invoke('pty_write', {
          id: ptyId,
          data: Array.from(enc.encode(d))
        }).catch(() => {});
      });

      // Shift+Enter: xterm emits the same byte (\r) for Enter and Shift+Enter, so a
      // TUI like claude can't tell them apart and submits on both. We intercept the
      // keydown and inject \n instead — the byte Ctrl+J sends, which claude treats as
      // "insert newline" in every terminal (no kitty/CSI-u negotiation required).
      //
      // Returning false alone is NOT enough: it suppresses xterm's keydown handling
      // but the follow-up `keypress` still emits the submitting \r. preventDefault()
      // on the keydown cancels that keypress, so the \r never reaches the PTY.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          if (ptyId !== undefined) {
            void invoke('pty_write', {
              id: ptyId,
              data: Array.from(enc.encode('\n'))
            }).catch(() => {});
          }
          return false;
        }
        // ⌘← / ⌘→: jump to the beginning / end of the current line (the macOS
        // convention). xterm captures keys via a hidden <textarea> and forwards
        // nothing for ⌘-modified arrows, so we translate them to the readline
        // line-edge bytes (Ctrl-A / Ctrl-E) and write them ourselves. preventDefault
        // + return false consumes the keystroke (no PTY echo, no webview accelerator).
        if (e.type === 'keydown') {
          const seq = lineEditSeq(e);
          if (seq) {
            e.preventDefault();
            if (ptyId !== undefined) {
              void invoke('pty_write', {
                id: ptyId,
                data: Array.from(enc.encode(seq))
              }).catch(() => {});
            }
            return false;
          }
        }
        // Esc INTERRUPT (claude panes): claude aborts the in-flight tool but fires no
        // PostToolUse/Stop for it, so the event-sourced status would stay pinned at
        // "working". Record a synthetic turn-end (a no-op unless this pane is actually
        // working) so the row returns to "waiting". The keystroke still flows to the PTY
        // unchanged (return true) so claude performs the interrupt itself.
        if (e.type === 'keydown' && e.key === 'Escape' && program === 'claude') {
          events.markInterrupt(paneId);
        }
        return true;
      });

      // Title: surface xterm title changes (OSC 0/2) to an interested parent (the
      // Terminals panel labels a terminal with the running command). Only wired when
      // a callback is supplied (agent panes pass none).
      if (onTitle) {
        const emit = onTitle;
        onTitleSub = term.onTitleChange((t) => emit(t));
      }

      // Resize round-trip: xterm computes new cols/rows on fit(); onResize then
      // propagates them to the PTY (SIGWINCH → TUIs reflow). Mark the resize so the
      // resulting redraw output is not read as work-activity (see noteResize) — e.g.
      // selecting an idle agent makes its pane visible → refit → resize → redraw,
      // which must not flash the agent In flight.
      onResizeSub = term.onResize(({ cols, rows }) => {
        if (ptyId === undefined) return;
        noteResize(paneId, Date.now());
        void invoke('pty_resize', { id: ptyId, cols, rows }).catch(() => {});
      });

      // Drive resizes from the container. Guard 0×0; fit() emits onResize when
      // the geometry actually changed, which is what hits pty_resize.
      ro = new ResizeObserver(() => {
        safeFit();
      });
      ro.observe(host);

      // One more fit now that input/resize wiring is live, in case layout settled
      // during the async spawn.
      safeFit();

      // NB: the OPTIONAL initial prompt is delivered by `deliverInitial()` once
      // claude's startup output goes quiet (TUI ready), with the text and the
      // submitting Enter sent as two separate writes — not here.
    })();

    // onMount's returned cleanup runs synchronously on destroy; we set the flag so
    // any still-pending async setup above bails out. The heavy disposal lives in
    // onDestroy (ordered).
    return () => {
      disposed = true;
    };
  });

  onDestroy(() => {
    // Ordered teardown (per spec): ResizeObserver.disconnect() → webgl.dispose()
    // → term.dispose() → close channel → pty_kill. Leaves no leaked DOM nodes,
    // listeners, or WebGL contexts, and kills the still-running child.
    unregisterTerminal(paneId);
    // Drop this pane's overview runtime entry so a closed pane leaves no stale
    // status behind (a removed pane should simply vanish from the roster).
    clearRuntime(paneId);

    // Cancel any pending initial-prompt delivery timers and the spinner backstop.
    readiness?.dispose();
    if (spinnerCapTimer) clearTimeout(spinnerCapTimer);

    ro?.disconnect();
    ro = undefined;

    onResizeSub?.dispose();
    onDataSub?.dispose();
    onTitleSub?.dispose();
    contextLossSub?.dispose();

    // File-link teardown: drop the ⌘/pointer/click listeners and scroll sub.
    onTermScroll?.dispose();
    onTermScroll = undefined;
    if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
    if (onKeyUp) window.removeEventListener('keyup', onKeyUp);
    if (onWinBlur) window.removeEventListener('blur', onWinBlur);
    if (onHostMove) host.removeEventListener('mousemove', onHostMove);
    if (onHostLeave) host.removeEventListener('mouseleave', onHostLeave);
    if (onHostDownCapture) host.removeEventListener('mousedown', onHostDownCapture, true);

    webgl?.dispose();
    webgl = undefined;

    term?.dispose();
    term = undefined;

    // Channel<T> has no explicit close in the Tauri API; dropping our reference
    // lets the backend's next send fail, which stops the read loop. Clear it so
    // late messages are ignored.
    if (channel) channel.onmessage = () => {};
    channel = undefined;

    if (ptyId !== undefined) {
      void invoke('pty_kill', { id: ptyId }).catch(() => {});
      ptyId = undefined;
    }
  });

  // Keep the WebGL renderer attached to the active pane only. When this pane
  // becomes active we load WebGL; when it goes inactive we dispose it (freeing a
  // GL context for whatever pane is now focused) and fall back to DOM. Reading
  // `active` makes this effect re-run on focus changes; `opened`/`webgl` are
  // plain locals so they don't (we gate the initial load on `opened` instead).
  $effect(() => {
    // Track `active` reactively.
    const isActive = active;
    if (!opened) return;
    if (isActive) {
      void loadWebgl();
    } else {
      disposeWebgl();
    }
  });

  // When a gutter drag ends (deferFit goes true -> false), run one fit to
  // settle the final geometry and push the resize to the PTY. While deferFit is
  // true, safeFit() is a no-op so nothing churns mid-drag.
  $effect(() => {
    if (!deferFit) {
      safeFit();
    }
  });

  // When this pane becomes visible (its workspace was switched to), the host
  // went from 0×0 (display:none) to its real size. Re-fit on the next frame —
  // after the browser has laid the now-shown element out — so cols/rows and the
  // PTY size match the (possibly changed) viewport. safeFit() guards 0×0, so the
  // hidden->visible transition is the meaningful one. ResizeObserver may not
  // reliably fire on a display toggle, so this explicit re-fit guarantees it.
  $effect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => safeFit());
    return () => cancelAnimationFrame(raf);
  });
</script>

<div
  class="pane"
  class:drop-target={dropTarget.paneId === paneId}
  data-pane-id={paneId}
  data-exited={exited}
  data-loading={loading}
>
  <div class="host" bind:this={host}>
    <!-- ⌘-hover file-link underline overlay; positioned + shown imperatively. -->
    <div class="file-link-underline" bind:this={underlineEl}></div>
  </div>
  {#if loading}
    <!-- Launch spinner: covers the pane while an agent spins up/resumes, so the
         half-rendered TUI never flashes. Cleared when the agent is ready (see
         LaunchSpinner). pointer-events:none so it never traps a click. -->
    <div class="loading" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div class="loading-label">{loadingLabel}</div>
    </div>
  {/if}
</div>

<style>
  .pane {
    position: relative;
    width: 100%;
    height: 100%;
    background: #0d1117;
    overflow: hidden;
  }

  /* Drag-drop affordance (terminal-file-drop): an accent ring + faint wash marking
     the session under a dragged file. An overlay (not a border) so it never
     reflows the terminal; above the launch spinner (z-index:10) and never traps
     the drop (pointer-events:none). */
  .pane.drop-target::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 11;
    pointer-events: none;
    border: 2px solid #58a6ff;
    background: rgba(88, 166, 255, 0.08);
  }

  .host {
    position: absolute;
    inset: 0;
    /* small breathing room around the grid; xterm fills the rest */
    padding: 4px 6px;
  }

  /* Launch spinner overlay: an opaque cover (matching the terminal background)
     so the half-rendered TUI never shows through while the agent spins up or
     resumes. pointer-events:none — purely visual, never intercepts a click. */
  .loading {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #0d1117;
    pointer-events: none;
  }

  .spinner {
    width: 22px;
    height: 22px;
    border: 2px solid #30363d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .loading-label {
    color: #8b949e;
    font:
      13px/1.2 ui-monospace,
      SFMono-Regular,
      'SF Mono',
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.02em;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Respect reduced-motion: drop the rotation, keep the labeled indicator. */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  /* xterm draws its own viewport; keep its internal scrollbar subtle */
  .host :global(.xterm) {
    height: 100%;
  }

  /* ⌘-hover file-link affordance: a dotted underline overlay positioned over the
     hovered path's cells (see terminal-file-links spec). Hidden until armed, and
     pointer-events disabled so it never intercepts hover/click on the terminal. */
  .file-link-underline {
    position: absolute;
    display: none;
    height: 0;
    border-bottom: 1px dotted #58a6ff;
    pointer-events: none;
    z-index: 5;
  }

  /* While a path is armed under the ⌘-cursor, force the pointer cursor. `!important`
     beats xterm's `.xterm.enable-mouse-events { cursor: default }` (claude's TUI
     turns mouse reporting on), and being a static class it persists at rest — no
     flicker. */
  .host :global(.xterm-screen.file-link-armed) {
    cursor: pointer !important;
  }
  .host :global(.xterm-viewport)::-webkit-scrollbar {
    width: 10px;
  }
  .host :global(.xterm-viewport)::-webkit-scrollbar-thumb {
    background: #30363d;
    border-radius: 5px;
  }
</style>
