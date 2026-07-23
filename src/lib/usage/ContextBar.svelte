<script lang="ts">
  // The focused pane's context window usage: a "ctx" label, the percent (colored
  // by fullness), then the colored StatusBar to the RIGHT of the percent. A dim
  // dash + striped bar when unknown.
  import StatusBar from './StatusBar.svelte';
  import { contextColor } from './barColor';

  let { pct }: { pct: number | null } = $props();

  function fmt(value: number | null): string {
    return value === null ? '—' : `${Math.round(value)}%`;
  }

  // The context bar warns earlier than the account limit bars (yellow >25%, red
  // >30%); one color drives BOTH the percent text and the StatusBar fill.
  const color = $derived(contextColor(pct));
</script>

<div class="ctx" aria-label="Focused pane context window used">
  <span class="label">ctx</span>
  <span class="val" class:dim={pct === null} style:color={pct === null ? null : color}>
    {fmt(pct)}
  </span>
  <StatusBar
    {pct}
    {color}
    label={pct === null
      ? 'Context window — usage unknown'
      : `Context window — ${Math.round(pct)}% of the focused agent's context used`}
  />
</div>

<style>
  .ctx {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .label {
    color: var(--fg-4);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .ctx :global(.bar) {
    width: 96px;
    flex: 0 0 96px;
  }
  .val {
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    min-width: 30px;
    text-align: right;
  }
  .val.dim {
    color: var(--fg-4);
    font-weight: 400;
  }
</style>
