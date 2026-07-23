<script lang="ts">
  // The Settings MODAL. Opened from the title-bar gear button via the shared
  // `settingsModal` store. Lets the user choose which application opens each file
  // bucket — HTML, code, other — defaulting to the OS default ("System Default").
  // Each change is persisted immediately by the `openWith` store. Follows the
  // HelpModal backdrop/dialog pattern. Dismiss with Esc / backdrop / close button.

  import { settingsModal } from './settingsStore.svelte';
  import Dropdown, { type DropdownOption } from './Dropdown.svelte';
  import {
    openWith,
    installedApps,
    visibleChoices,
    appIcon,
    APP_CHOICES,
    SYSTEM,
    CUSTOM,
    type FileBucket
  } from '$lib/settings/openWith.svelte';
  import { voice } from '$lib/settings/voice.svelte';
  import { autoAdvance } from '$lib/settings/autoAdvance.svelte';
  import { compactMode } from '$lib/settings/compactMode.svelte';
  import { projectAgentCounts } from '$lib/settings/projectAgentCounts.svelte';
  import { shellSettings } from '$lib/settings/shell.svelte';
  import { subagentsVisible } from '$lib/settings/subagentsVisible.svelte';
  import { notifications, type AlertMode } from '$lib/settings/notifications.svelte';
  import { ensureDesktopPermission } from '$lib/overview/alerts.svelte';
  import { titleSettings } from '$lib/settings/titles.svelte';
  import { theme, type ThemeMode } from '$lib/settings/theme.svelte';
  import { appVersionLabel } from '$lib/settings/version';
  import { updateStore } from '$lib/updates/updateStore.svelte';
  import { runUpdateCheck } from '$lib/updates/checkForUpdate';
  import {
    ensureModels,
    modelsStatus,
    modelsDiskUsage,
    deleteModels,
    formatBytes,
    type ModelsStatus
  } from '$lib/voice/models';
  import { modelDownload } from '$lib/voice/modelStore.svelte';

  // Voice-model readiness line: re-query whenever the modal is open and the
  // tier/polish selection changes, so the user sees "ready" vs "download". The
  // download is delegated to the shared `ensureModels` so the panel + settings
  // share one in-flight session (progress reflected in `modelDownload`).
  let modelStatus = $state<ModelsStatus | null>(null);
  // Reclaimable disk used by downloaded models (bytes); drives the delete control.
  let presentBytes = $state(0);
  // True while a delete is in flight, to disable the button and avoid double-fire.
  let deleting = $state(false);
  $effect(() => {
    if (!settingsModal.open) return;
    const tier = voice.prefs.modelTier;
    const polish = voice.prefs.polish;
    void modelsStatus(tier, polish).then((s) => {
      modelStatus = s;
    });
    void modelsDiskUsage().then((b) => {
      presentBytes = b;
    });
  });
  async function downloadModels() {
    await ensureModels(voice.prefs.modelTier, voice.prefs.polish);
    modelStatus = await modelsStatus(voice.prefs.modelTier, voice.prefs.polish);
    presentBytes = await modelsDiskUsage();
  }
  // Delete all downloaded models, then refresh status + usage so the row flips to
  // "None downloaded" and the Voice "Download" button reappears.
  async function deleteDownloaded() {
    deleting = true;
    try {
      await deleteModels();
      presentBytes = await modelsDiskUsage();
      modelStatus = await modelsStatus(voice.prefs.modelTier, voice.prefs.polish);
    } finally {
      deleting = false;
    }
  }

  // Detect which curated apps are installed whenever the modal opens, so the
  // open-with dropdowns offer only apps present on the system (strict filter).
  $effect(() => {
    if (settingsModal.open) void installedApps.load();
  });

  // The buckets, in display order, with human labels.
  const ROWS: { bucket: FileBucket; label: string }[] = [
    { bucket: 'code', label: 'Code files' },
    { bucket: 'html', label: 'HTML files and URLs' },
    { bucket: 'markdown', label: 'Markdown files' },
    { bucket: 'other', label: 'Other files' }
  ];

  // The dropdown options for a bucket: "System Default", the installed curated apps
  // (filtered + icon-tagged), then "Custom…". Reads `installedApps`/`openWith` so it
  // re-derives when detection resolves or the saved value changes.
  function openWithOptions(bucket: FileBucket): DropdownOption[] {
    const apps = visibleChoices(
      APP_CHOICES[bucket],
      installedApps.installed,
      openWith.prefs[bucket]
    );
    return [
      { value: SYSTEM, label: 'System Default', icon: appIcon(SYSTEM) },
      ...apps.map((app) => ({ value: app, label: app, icon: appIcon(app) })),
      { value: CUSTOM, label: 'Custom…', icon: appIcon(CUSTOM) }
    ];
  }

  // Static option lists for the non-app dropdowns (no icons).
  const DENSITY_OPTIONS: DropdownOption[] = [
    { value: 'default', label: 'Default' },
    { value: 'compact', label: 'Compact' }
  ];
  const QUALITY_OPTIONS: DropdownOption[] = [
    { value: 'accurate', label: 'Accurate (large-v3-turbo)' },
    { value: 'fast', label: 'Fast (small)' }
  ];
  const SOUND_OPTIONS: DropdownOption[] = [
    { value: 'off', label: 'Never' },
    { value: 'app-unfocused', label: 'When app is in the background' },
    { value: 'agent-unfocused', label: 'When not viewing that agent' },
    { value: 'always', label: 'Always' }
  ];
  const DESKTOP_OPTIONS: DropdownOption[] = [
    { value: 'off', label: 'Never' },
    { value: 'app-unfocused', label: 'When app is in the background' }
  ];
  const THEME_OPTIONS: DropdownOption[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'Match system' }
  ];

  // Per-row: is the value a curated choice, or a custom name needing the text field?
  // Derived from the live prefs so reopening reflects the saved value.
  function isCustom(bucket: FileBucket): boolean {
    const v = openWith.prefs[bucket];
    return v !== SYSTEM && !APP_CHOICES[bucket].includes(v);
  }

  // The dropdown's current value: SYSTEM, a known app, or the CUSTOM sentinel.
  function selectValue(bucket: FileBucket): string {
    return isCustom(bucket) ? CUSTOM : openWith.prefs[bucket];
  }

  function onSelect(bucket: FileBucket, value: string) {
    if (value === CUSTOM) {
      // Switch into custom mode with an empty name; the text field takes over.
      openWith.set(bucket, '');
    } else {
      openWith.set(bucket, value);
    }
  }

  function onCustomInput(bucket: FileBucket, value: string) {
    openWith.set(bucket, value);
  }

  // App version for the footer + the update row: "dev" under a dev server, else
  // "v<version>". Build-time constants — no reactivity needed.
  const versionLabel = appVersionLabel({
    version: __APP_VERSION__,
    dev: import.meta.env.DEV
  });

  // Manual "Check for updates": the user-initiated outcome (checking / up to date /
  // couldn't check). Download + ready/failed states come from the shared
  // `updateStore` (which the row reads directly), so a manual-found update also
  // lights the title-bar pill. `started`/`noop`/`unavailable` defer to the store.
  let manualStatus = $state<'idle' | 'checking' | 'up-to-date' | 'error'>('idle');
  async function checkForUpdates() {
    manualStatus = 'checking';
    const outcome = await runUpdateCheck();
    manualStatus =
      outcome === 'up-to-date' ? 'up-to-date' : outcome === 'error' ? 'error' : 'idle';
  }
  // Reset the manual result each time the modal opens, so it shows a fresh button
  // rather than a stale "up to date" / "couldn't check" from a prior session.
  $effect(() => {
    if (settingsModal.open) manualStatus = 'idle';
  });

  function close() {
    settingsModal.close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

{#if settingsModal.open}
  <!-- Backdrop: a click outside the dialog closes. -->
  <div class="backdrop" role="presentation" onclick={close} onkeydown={onKeydown}>
    <!-- The dialog. stopPropagation on click so an inside click doesn't close. -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
    >
      <header class="head">
        <h2>Settings</h2>
        <button class="x" aria-label="Close" onclick={close}>×</button>
      </header>

      <section class="group">
        <span class="label">Appearance</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Theme</span>
            <div class="control">
              <!-- Focus the first setting control on open (skips the header ×). -->
              <Dropdown
                value={theme.prefs.mode}
                options={THEME_OPTIONS}
                onChange={(v) => theme.setMode(v as ThemeMode)}
                ariaLabel="Theme"
                autofocusTrigger
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Sessions panel</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Density</span>
            <div class="control">
              <Dropdown
                value={compactMode.prefs.enabled ? 'compact' : 'default'}
                options={DENSITY_OPTIONS}
                onChange={(v) => compactMode.setEnabled(v === 'compact')}
                ariaLabel="Density"
              />
            </div>
          </li>
          <li class="row">
            <span class="desc">Show subagents under each session</span>
            <div class="control">
              <input
                type="checkbox"
                checked={subagentsVisible.prefs.enabled}
                onchange={(e) => subagentsVisible.setEnabled(e.currentTarget.checked)}
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Terminal</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Shell for new panes</span>
            <div class="control">
              <!-- Empty means "use the platform default", which the placeholder
                   shows so the user can see what is in effect before choosing. -->
              <input
                class="custom"
                type="text"
                placeholder={shellSettings.platformDefault}
                aria-label="Shell for new panes"
                value={shellSettings.prefs.program}
                onchange={(e) => shellSettings.setProgram(e.currentTarget.value)}
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Open files with</span>
        <ul class="rows">
          {#each ROWS as row (row.bucket)}
            <li class="row">
              <span class="desc">{row.label}</span>
              <div class="control">
                <Dropdown
                  value={selectValue(row.bucket)}
                  options={openWithOptions(row.bucket)}
                  onChange={(v) => onSelect(row.bucket, v)}
                  ariaLabel={row.label}
                />
                {#if isCustom(row.bucket)}
                  <input
                    class="custom"
                    type="text"
                    placeholder="App name (e.g. Cursor)"
                    value={openWith.prefs[row.bucket]}
                    oninput={(e) => onCustomInput(row.bucket, e.currentTarget.value)}
                  />
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>

      <section class="group">
        <span class="label">Voice</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Enable voice input</span>
            <div class="control">
              <input
                type="checkbox"
                checked={voice.prefs.enabled}
                onchange={(e) => voice.setEnabled(e.currentTarget.checked)}
              />
            </div>
          </li>
          <li class="row">
            <span class="desc">Clean up transcript (polish)</span>
            <div class="control">
              <input
                type="checkbox"
                checked={voice.prefs.polish}
                disabled={!voice.prefs.enabled}
                onchange={(e) => voice.setPolish(e.currentTarget.checked)}
              />
            </div>
          </li>
          <li class="row">
            <span class="desc">Transcription quality</span>
            <div class="control">
              <Dropdown
                value={voice.prefs.modelTier}
                options={QUALITY_OPTIONS}
                disabled={!voice.prefs.enabled}
                onChange={(v) => voice.setModelTier(v as 'fast' | 'accurate')}
                ariaLabel="Transcription quality"
              />
            </div>
          </li>
          <li class="row">
            <span class="desc">Models</span>
            <div class="control">
              {#if modelDownload.active}
                <span class="model-status">Downloading… {modelDownload.percent}%</span>
              {:else if modelStatus?.ready}
                <span class="model-status ready">Ready</span>
              {:else if modelStatus}
                <button
                  type="button"
                  class="model-download"
                  disabled={!voice.prefs.enabled}
                  onclick={downloadModels}
                >
                  Download ({modelStatus.missing.length})
                </button>
              {:else}
                <span class="model-status">Checking…</span>
              {/if}
            </div>
          </li>
          <li class="row">
            <span class="desc">Downloaded models</span>
            <div class="control">
              {#if presentBytes > 0}
                <button
                  type="button"
                  class="model-delete"
                  disabled={deleting || modelDownload.active}
                  onclick={deleteDownloaded}
                >
                  {deleting ? 'Deleting…' : `Delete (${formatBytes(presentBytes)})`}
                </button>
              {:else}
                <span class="model-status">None downloaded</span>
              {/if}
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Focus behavior</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Auto-advance to the next agent that needs input</span>
            <div class="control">
              <input
                type="checkbox"
                checked={autoAdvance.prefs.enabled}
                onchange={(e) => autoAdvance.setEnabled(e.currentTarget.checked)}
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Notifications</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Sound when an agent needs input</span>
            <div class="control">
              <Dropdown
                value={notifications.prefs.sound.mode}
                options={SOUND_OPTIONS}
                onChange={(v) => notifications.setSoundMode(v as AlertMode)}
                width={220}
                ariaLabel="Sound when an agent needs input"
              />
            </div>
          </li>
          <li class="row">
            <span class="desc">Desktop notification when an agent needs input</span>
            <div class="control">
              <Dropdown
                value={notifications.prefs.desktop.mode}
                options={DESKTOP_OPTIONS}
                width={220}
                ariaLabel="Desktop notification when an agent needs input"
                onChange={(v) => {
                  const mode = v as AlertMode;
                  notifications.setDesktopMode(mode);
                  // Request OS notification permission as soon as the channel is enabled.
                  if (mode !== 'off') void ensureDesktopPermission();
                }}
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Session titles</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Use cloud (Haiku) when on-device titles are unavailable</span>
            <div class="control">
              <input
                type="checkbox"
                checked={titleSettings.prefs.cloudFallback}
                onchange={(e) => titleSettings.setCloudFallback(e.currentTarget.checked)}
              />
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Software update</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Agent Desktop {versionLabel}</span>
            <div class="control">
              {#if updateStore.status === 'downloading'}
                <span class="model-status">
                  {updateStore.percent === null
                    ? 'Downloading…'
                    : `Downloading… ${updateStore.percent}%`}
                </span>
              {:else if updateStore.status === 'installing'}
                <span class="model-status">Restarting…</span>
              {:else if updateStore.status === 'ready'}
                <button type="button" class="model-download" onclick={() => void updateStore.restartToUpdate()}>
                  Update ready — restart
                </button>
              {:else if updateStore.status === 'failed'}
                <button type="button" class="model-delete" onclick={() => void updateStore.retry()}>
                  Update failed · retry
                </button>
              {:else if manualStatus === 'checking'}
                <span class="model-status">Checking…</span>
              {:else if manualStatus === 'up-to-date'}
                <span class="model-status ready">You're up to date</span>
              {:else if manualStatus === 'error'}
                <button type="button" class="model-delete" onclick={checkForUpdates}>
                  Couldn't check · retry
                </button>
              {:else}
                <button type="button" class="model-download" onclick={checkForUpdates}>
                  Check for updates
                </button>
              {/if}
            </div>
          </li>
        </ul>
      </section>

      <section class="group">
        <span class="label">Features</span>
        <ul class="rows">
          <li class="row">
            <span class="desc">Show waiting vs working agent counts on projects</span>
            <div class="control">
              <input
                type="checkbox"
                checked={projectAgentCounts.prefs.enabled}
                onchange={(e) => projectAgentCounts.setEnabled(e.currentTarget.checked)}
              />
            </div>
          </li>
        </ul>
      </section>

      <footer class="version">{versionLabel}</footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    background: rgba(4, 6, 10, 0.66);
    backdrop-filter: blur(3px);
  }

  .dialog {
    width: min(540px, calc(100vw - 32px));
    max-height: 80vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 18px 20px 20px;
    background: var(--space-800);
    border: 1px solid var(--line-default);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    color: var(--fg-1);
    font-family: var(--font-sans);
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }
  .x {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--fg-3);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .x:hover {
    background: var(--line-faint);
    color: var(--fg-1);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--fg-3);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line-faint);
  }
  .row:last-child {
    border-bottom: none;
  }
  .desc {
    font-size: 13px;
    color: var(--fg-1);
    min-width: 0;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  /* Custom app-name field (shown when a bucket is set to "Custom…"). The dropdowns
     are styled inside Dropdown.svelte; this text input matches their trigger. */
  .custom {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--line-default);
    border-radius: var(--r-sm);
    background: var(--space-650);
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: 12.5px;
    width: 160px;
    cursor: text;
  }
  .custom:hover {
    border-color: var(--line-strong);
  }
  .custom:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* Voice toggles: native checkbox accented to the app color. */
  input[type='checkbox'] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  input[type='checkbox']:disabled,
  .model-download:disabled,
  .model-delete:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Voice model readiness line. */
  .model-status {
    font-size: 13px;
    color: var(--fg-3);
  }
  .model-status.ready {
    color: var(--fg-2);
  }
  .model-download {
    font-size: 13px;
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-default);
    background: var(--space-650);
    color: var(--fg-1);
    cursor: pointer;
  }
  .model-download:not(:disabled):hover {
    background: var(--space-600);
  }

  /* Destructive variant: same shape as the download button, danger-tinted. */
  .model-delete {
    font-size: 13px;
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-default);
    background: var(--space-650);
    color: var(--danger);
    cursor: pointer;
  }
  .model-delete:not(:disabled):hover {
    border-color: var(--danger);
    background: var(--space-600);
  }

  /* Footer: the running app version (or "dev"), muted and centered. */
  .version {
    margin-top: 2px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--fg-3);
    user-select: text;
  }
</style>
