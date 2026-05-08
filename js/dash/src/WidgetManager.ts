import type { WidgetUpdate } from './types';

export class WidgetManager {
  private _widgets = new Map<string, WidgetUpdate>();

  update(widget: WidgetUpdate): void {
    this._widgets.set(widget.widgetId, widget);
  }

  get(widgetId: string): WidgetUpdate | undefined {
    return this._widgets.get(widgetId);
  }

  getAll(): WidgetUpdate[] {
    return Array.from(this._widgets.values());
  }

  clear(): void {
    this._widgets.clear();
  }
}
