import { describe, it, expect } from 'vitest';
import {
  barColor,
  contextColor,
  BAR_YELLOW_AT,
  BAR_RED_AT,
  CONTEXT_YELLOW_AT,
  CONTEXT_RED_AT
} from './barColor';

describe('barColor', () => {
  it('thresholds are 50 (yellow) and 80 (red)', () => {
    expect(BAR_YELLOW_AT).toBe(50);
    expect(BAR_RED_AT).toBe(80);
  });

  it('green below 50', () => {
    expect(barColor(0)).toBe('var(--nominal-500)');
    expect(barColor(49)).toBe('var(--nominal-500)');
  });

  it('yellow from 50 to 79', () => {
    expect(barColor(50)).toBe('var(--caution-500)');
    expect(barColor(79)).toBe('var(--caution-500)');
  });

  it('red from 80 up', () => {
    expect(barColor(80)).toBe('var(--abort-500)');
    expect(barColor(100)).toBe('var(--abort-500)');
  });

  it('neutral track for null / non-finite', () => {
    expect(barColor(null)).toBe('var(--space-600)');
    expect(barColor(NaN)).toBe('var(--space-600)');
    expect(barColor(Infinity)).toBe('var(--space-600)');
  });

  it('treats negative as green (below yellow)', () => {
    expect(barColor(-5)).toBe('var(--nominal-500)');
  });

  it('honors custom thresholds passed explicitly', () => {
    expect(barColor(26, 25, 30)).toBe('var(--caution-500)');
    expect(barColor(24, 25, 30)).toBe('var(--nominal-500)');
    expect(barColor(30, 25, 30)).toBe('var(--abort-500)');
  });
});

describe('contextColor — the context bar warns earlier (25 / 30)', () => {
  it('exports the aggressive context thresholds', () => {
    expect(CONTEXT_YELLOW_AT).toBe(25);
    expect(CONTEXT_RED_AT).toBe(30);
  });

  it('green below 25', () => {
    expect(contextColor(0)).toBe('var(--nominal-500)');
    expect(contextColor(24)).toBe('var(--nominal-500)');
  });

  it('yellow from 25 to 29', () => {
    expect(contextColor(25)).toBe('var(--caution-500)');
    expect(contextColor(29)).toBe('var(--caution-500)');
  });

  it('red from 30 up', () => {
    expect(contextColor(30)).toBe('var(--abort-500)');
    expect(contextColor(100)).toBe('var(--abort-500)');
  });

  it('neutral track for null / non-finite', () => {
    expect(contextColor(null)).toBe('var(--space-600)');
    expect(contextColor(NaN)).toBe('var(--space-600)');
  });
});
