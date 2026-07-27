<script lang="ts">
  // A project picker for the launcher (ports LaunchModal.jsx's ProjectSelect): a
  // dropdown of existing projects (tinted icon + name + folder) plus an inline
  // "New project" create (name + Browse folder + icon picker). Emits the chosen
  // project id via `onChange`. The project supplies the launch folder, so picking
  // a project is how the launcher chooses where the agent runs.

  import { onMount } from 'svelte';
  import { projects } from './projects.svelte';
  import { taskBoard } from '../orchestration/taskBoard.svelte';
  import { projectForId, PROJECT_ICON_CHOICES, hexA } from './projects';
  import { pickFolder } from '../launcher/pick';
  import Icon from '../icons/Icon.svelte';
  import { tooltip } from '../ui/tooltip';

  let {
    value,
    onChange,
    autofocus = false
  }: { value: string | null; onChange: (id: string) => void; autofocus?: boolean } = $props();

  let open = $state(false);

  // Keyboard nav: a roving HIGHLIGHT over the menu options while focus stays on the
  // trigger (combobox pattern). Index 0..N-1 are the projects; index N is the
  // "New project" row. -1 means nothing highlighted.
  let active = $state(-1);
  const optionCount = $derived(projects.list.length + 1); // projects + "New project"
  let menuEl = $state<HTMLDivElement | null>(null);

  // The trigger button — focused on mount when `autofocus` is set, with the menu
  // already OPEN so you can arrow through projects immediately. rAF so focus lands
  // after the modal's own mount/layout settles.
  let triggerEl = $state<HTMLButtonElement | null>(null);
  onMount(() => {
    if (autofocus) {
      openMenu();
      requestAnimationFrame(() => triggerEl?.focus());
    }
  });
  const current = $derived(projectForId(projects.list, value));

  /** Open the menu and highlight the current selection (or the first option). */
  function openMenu() {
    open = true;
    const i = projects.list.findIndex((p) => p.id === value);
    active = i >= 0 ? i : 0;
  }

  function toggleOpen() {
    if (open) open = false;
    else openMenu();
  }

  /** Activate the highlighted option: pick that project, or open the create flow. */
  function activateActive() {
    if (active >= 0 && active < projects.list.length) choose(projects.list[active].id);
    else creating = true; // the "New project" row
  }

  /** Combobox keys on the trigger (focus stays here): arrows move the highlight,
   *  Enter/Space activate it, Escape closes JUST the dropdown. The create box owns
   *  the keyboard once you're creating. */
  function onTriggerKey(e: KeyboardEvent) {
    if (creating) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        active = Math.min(optionCount - 1, active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        active = Math.max(0, active - 1);
        break;
      case 'Home':
        e.preventDefault();
        active = 0;
        break;
      case 'End':
        e.preventDefault();
        active = optionCount - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activateActive();
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation(); // close the dropdown, not the whole modal
        open = false;
        break;
      case 'Tab':
        open = false; // let focus move on naturally
        break;
    }
  }

  // Keep the highlighted option scrolled into view as you arrow through a long list.
  $effect(() => {
    if (!open || !menuEl || active < 0) return;
    const opts = menuEl.querySelectorAll('.psel-opt');
    (opts[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  });

  // --- create sub-flow ---
  let creating = $state(false);
  let name = $state('');
  let folder = $state('');
  let pick = $state(PROJECT_ICON_CHOICES[0]);
  let browsing = $state(false);
  const canCreate = $derived(name.trim() !== '' && folder.trim() !== '');

  async function browse() {
    if (browsing) return;
    browsing = true;
    try {
      const picked = await pickFolder(folder.trim() || undefined);
      if (picked) folder = picked;
    } finally {
      browsing = false;
    }
  }

  function resetCreate() {
    creating = false;
    name = '';
    folder = '';
    pick = PROJECT_ICON_CHOICES[0];
  }

  async function create() {
    if (!canCreate) return;
    const stored = await projects.add({
      id: crypto.randomUUID(),
      name: name.trim(),
      path: folder.trim(),
      icon: pick.icon,
      color: pick.color
    });
    // Register the new project's path with the coordinator task board so its
    // mutations debounce-persist (a mid-session project is never `load`ed at mount).
    taskBoard.register(stored.id, stored.path);
    onChange(stored.id);
    resetCreate();
    open = false;
  }

  function choose(id: string) {
    onChange(id);
    open = false;
  }
</script>

<div class="psel">
  <button
    type="button"
    class="psel-btn"
    bind:this={triggerEl}
    onclick={toggleOpen}
    onkeydown={onTriggerKey}
  >
    {#if current}
      <Icon name={current.icon} size={16} color={current.color} />
      <span class="psel-name">{current.name}</span>
      <span class="psel-repo" use:tooltip={current.path}>{current.path}</span>
    {:else}
      <Icon name="folder" size={16} color="var(--fg-3)" />
      <span class="psel-name dim">Choose a project…</span>
    {/if}
    <Icon name="arrow-up" size={14} color="var(--fg-3)" />
  </button>

  {#if open}
    <div class="psel-menu" bind:this={menuEl}>
      {#each projects.list as p, i (p.id)}
        <button
          type="button"
          class="psel-opt"
          class:on={p.id === value}
          class:hl={active === i}
          onmousemove={() => (active = i)}
          onclick={() => choose(p.id)}
        >
          <Icon name={p.icon} size={15} color={p.color} />
          <span class="psel-name">{p.name}</span>
          {#if p.id === value}<Icon name="check" size={14} color="var(--blue-300)" />{/if}
        </button>
      {/each}

      {#if projects.list.length > 0}<div class="psel-sep"></div>{/if}

      {#if creating}
        <div class="psel-createbox">
          <div class="icon-picker">
            {#each PROJECT_ICON_CHOICES as choice (choice.icon)}
              <button
                type="button"
                class="ipick"
                class:on={pick.icon === choice.icon}
                style:border-color={pick.icon === choice.icon ? hexA(choice.color, 0.55) : undefined}
                style:background={pick.icon === choice.icon ? hexA(choice.color, 0.16) : undefined}
                aria-label={choice.icon}
                onclick={() => (pick = choice)}
              >
                <Icon name={choice.icon} size={15} color={choice.color} />
              </button>
            {/each}
          </div>
          <button class="psel-browse" onclick={browse} disabled={browsing}>
            <Icon name="folder" size={14} color="var(--fg-3)" />
            <span class="psel-folder" class:empty={!folder.trim()} use:tooltip={folder}>
              {folder.trim() || (browsing ? 'Opening…' : 'Choose folder…')}
            </span>
          </button>
          <div class="psel-create">
            <Icon name={pick.icon} size={15} color={pick.color} />
            <!-- svelte-ignore a11y_autofocus -->
            <input
              autofocus
              bind:value={name}
              placeholder="Project name…"
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void create();
                }
              }}
            />
            <button class="icon-send" disabled={!canCreate} onclick={create} aria-label="Create">
              <Icon name="check" size={15} color="#fff" />
            </button>
          </div>
        </div>
      {:else}
        <button
          type="button"
          class="psel-opt psel-new"
          class:hl={active === projects.list.length}
          onmousemove={() => (active = projects.list.length)}
          onclick={() => (creating = true)}
        >
          <Icon name="plus" size={15} color="var(--blue-300)" />
          <span>New project</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .psel {
    position: relative;
  }
  .psel-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    background: rgba(56, 65, 85, 0.35);
    border: 1px solid var(--line-default);
    border-radius: var(--r-md);
    padding: 10px 12px;
    cursor: pointer;
    color: var(--fg-1);
  }
  .psel-btn:hover {
    border-color: var(--line-strong);
  }
  /* Make the auto-focused trigger obviously focused when the dialog opens. */
  .psel-btn:focus-visible {
    outline: none;
    border-color: var(--blue-500);
    box-shadow: var(--focus-ring);
  }
  .psel-name {
    font-size: 13.5px;
    font-weight: 500;
  }
  .psel-name.dim {
    color: var(--fg-4);
    font-weight: 400;
  }
  .psel-repo {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-4);
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }
  .psel-menu {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 6px);
    z-index: 60;
    background: var(--space-700);
    border: 1px solid var(--line-default);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-pop);
    padding: 5px;
    max-height: 320px;
    overflow-y: auto;
  }
  .psel-opt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--fg-2);
    font-size: 13.5px;
    padding: 9px 10px;
    border-radius: var(--r-sm);
  }
  .psel-opt:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--fg-1);
  }
  /* Keyboard highlight (roving). Mirrors hover but with a clear accent edge. */
  .psel-opt.hl {
    background: rgba(61, 123, 255, 0.16);
    color: var(--fg-1);
    box-shadow: inset 2px 0 0 var(--blue-500);
  }
  .psel-opt .psel-name {
    flex: 1;
  }
  .psel-sep {
    height: 1px;
    background: var(--line-subtle);
    margin: 5px 2px;
  }
  .psel-new {
    color: var(--blue-300);
    font-weight: 600;
  }
  .psel-createbox {
    padding: 4px 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .icon-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ipick {
    width: 30px;
    height: 30px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--space-900);
    border: 1px solid var(--line-default);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .ipick:hover {
    border-color: var(--line-strong);
  }
  .psel-browse {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--space-900);
    border: 1px solid var(--line-default);
    border-radius: var(--r-sm);
    padding: 7px 9px;
    cursor: pointer;
  }
  .psel-browse:hover {
    border-color: var(--line-strong);
  }
  .psel-folder {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-2);
  }
  .psel-folder.empty {
    color: var(--fg-4);
    font-style: italic;
  }
  .psel-create {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .psel-create input {
    flex: 1;
    min-width: 0;
    background: var(--space-900);
    border: 1px solid var(--blue-500);
    box-shadow: var(--focus-ring);
    border-radius: var(--r-sm);
    padding: 7px 10px;
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: 13px;
    outline: none;
  }
  .icon-send {
    width: 32px;
    height: 32px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-sm);
    background: var(--blue-500);
    border: none;
    cursor: pointer;
  }
  .icon-send:hover:not(:disabled) {
    background: var(--blue-600);
  }
  .icon-send:disabled {
    background: var(--space-600);
    cursor: not-allowed;
  }
</style>
