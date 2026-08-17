/**
 * `/toolrecovery-model` picker.
 *
 * Opens a non-fullscreen overlay with a search box. As the user types, the
 * model list is fuzzy-filtered (see `fuzzyScore` and `ModelPicker.applyFuzzyFilter`).
 * enter selects, escape cancels. Outside TUI mode it falls back to a plain
 * `ctx.ui.select` list.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type Component,
  type SelectItem,
  type SelectListTheme,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export interface PickedModel {
  provider: string;
  id: string;
}

// ---- Fuzzy search (ported from HanzCEO/pi-codebase-reader) ----

/**
 * Score how well `query` matches `target` using fuzzy matching.
 *
 * All characters of `query` must appear **in order** somewhere in `target`
 * (case-insensitive). Returns a numeric score where **lower is better**, or
 * `null` when there is no match.
 *
 * Scoring tiers (best -> worst):
 *   0    Exact match
 *   1    Query is a prefix
 *   2+   Query is a contiguous substring (score = position of substring + 2)
 *   10+  Non-contiguous fuzzy match with gap penalties
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0; // empty matches everything

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact match -> best possible score
  if (t === q) return 0;

  // Prefix match
  if (t.startsWith(q)) return 1;

  // Contiguous substring match
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) return subIdx + 2;

  // Non-contiguous fuzzy match: every character of q must appear in order
  let qi = 0;
  let score = 0;
  let lastMatchPos = -2; // so the first match's consecutive bonus doesn't trigger

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive matches lower the score (bonus)
      if (ti === lastMatchPos + 1) {
        score -= 1;
      } else {
        // Penalty for gap since last match
        score += ti - lastMatchPos;
      }
      qi++;
      lastMatchPos = ti;
    }
  }

  // Not all query characters were found in order
  if (qi < q.length) return null;

  // Small penalty for trailing characters after last match
  score += t.length - lastMatchPos;

  // Baseline so fuzzy scores are always > substring scores
  return score + 10;
}

class ModelPicker implements Component {
  private query = "";
  private list: SelectList;
  // Full, unfiltered list of models. The fuzzy filter always re-derives from
  // this so that deleting characters re-expands correctly.
  private allItems: SelectItem[];
  // Theme is passed by pi; its shape is not part of our public type surface.
  private theme: any;

  constructor(
    items: SelectItem[],
    theme: any,
    private requestRender: () => void,
    onDone: (item: SelectItem | null) => void,
  ) {
    this.allItems = items;
    this.theme = theme;
    const listTheme: SelectListTheme = {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    };
    this.list = new SelectList(items, 12, listTheme);
    this.list.onSelect = (item) => onDone(item);
    this.list.onCancel = () => onDone(null);
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape)
    ) {
      this.list.handleInput(data);
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.applyFuzzyFilter();
      return;
    }

    // Printable character: extend the query.
    if (data.length === 1 && !/[\x00-\x1f]/.test(data)) {
      this.query += data;
      this.applyFuzzyFilter();
    }
  }

  /**
   * Replaces `SelectList.setFilter` (which is prefix-only) with proper fuzzy
   * scoring. Each item is scored against both its `value` and `label`, the
   * best (lowest) score wins, non-matches are dropped, and the survivors are
   * sorted best-first. Empty query restores the full list.
   */
  private applyFuzzyFilter(): void {
    const query = this.query;

    if (!query) {
      // Empty query: restore the full list.
      (this.list as any).items = this.allItems;
      (this.list as any).filteredItems = this.allItems;
      (this.list as any).selectedIndex = 0;
      this.requestRender();
      return;
    }

    const scored = this.allItems
      .map((item) => {
        const candidates = [
          fuzzyScore(query, item.value),
          fuzzyScore(query, item.label),
        ].filter((s): s is number => s !== null);
        return {
          item,
          score: candidates.length ? Math.min(...candidates) : null,
        };
      })
      .filter((x): x is { item: SelectItem; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score);

    const matched = scored.map((x) => x.item);
    (this.list as any).items = matched;
    (this.list as any).filteredItems = matched;
    (this.list as any).selectedIndex = 0;
    this.requestRender();
  }

  render(width: number): string[] {
    const border = this.theme.fg("accent", "─".repeat(width));
    const lines: string[] = [];
    lines.push(border);
    lines.push(truncateToWidth(this.theme.fg("accent", "> ") + this.query + this.theme.fg("dim", "█"), width));
    for (const line of this.list.render(width)) lines.push(line);
    lines.push(this.theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"));
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    /* render is cheap; nothing cached */
  }
}

export async function pickRecoveryModel(ctx: ExtensionContext): Promise<PickedModel | null> {
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) {
    ctx.ui.notify("No models available to choose as the recovery model", "warning");
    return null;
  }

  const items: SelectItem[] = models.map((m) => ({
    value: `${m.provider}|${m.id}`,
    label: m.name || `${m.provider}/${m.id}`,
    description: m.provider,
  }));

  if (ctx.mode !== "tui") {
    const labels = items.map((it) => `${it.label}  (${it.description})`);
    const choice = await ctx.ui.select("Recovery model", labels);
    if (!choice) return null;
    const idx = labels.indexOf(choice);
    if (idx < 0) return null;
    const [provider, id] = items[idx].value.split("|");
    return { provider, id };
  }

  const result = await ctx.ui.custom<SelectItem | null>(
    (tui, theme, _kb, done) => new ModelPicker(items, theme, () => tui.requestRender(), done),
    { overlay: true },
  );

  if (!result) return null;
  const [provider, id] = result.value.split("|");
  return { provider, id };
}
