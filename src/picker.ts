/**
 * `/toolrecovery-model` picker.
 *
 * Opens a non-fullscreen overlay with a search box. As the user types, the
 * model list is filtered (via `SelectList.setFilter`). Arrow keys navigate,
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

class ModelPicker implements Component {
  private query = "";
  private list: SelectList;
  // Theme is passed by pi; its shape is not part of our public type surface.
  private theme: any;

  constructor(
    items: SelectItem[],
    theme: any,
    private requestRender: () => void,
    onDone: (item: SelectItem | null) => void,
  ) {
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
      this.list.setFilter(this.query);
      this.invalidate();
      this.requestRender();
      return;
    }

    // Printable character: extend the filter.
    if (data.length === 1 && !/[\x00-\x1f]/.test(data)) {
      this.query += data;
      this.list.setFilter(this.query);
      this.invalidate();
      this.requestRender();
    }
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
