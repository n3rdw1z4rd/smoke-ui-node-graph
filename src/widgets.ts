import { clamp } from '@n3rdw1z4rd/core';
import type { WidgetSpec } from '@n3rdw1z4rd/core/graph';
import { parseType } from '@n3rdw1z4rd/core/graph';
import { h } from './dom';

/* ------------------------------------------------------------------ */
/* Inline widgets for params and unconnected inputs, by type.          */
/* ------------------------------------------------------------------ */

const EDITABLE = new Set(['number', 'boolean', 'string', 'color', 'enum', 'vec2']);

/** Whether a (non-list) type gets an inline widget. */
export function hasWidget(type: string, spec: WidgetSpec = {}): boolean {
    const t = parseType(type);
    return !t.list && (EDITABLE.has(t.base) || (t.base === 'string' && !!spec.multiline) || !!spec.options);
}

/**
 * A widget showing `value` that calls `commit` with the new value. Numbers commit on Enter /
 * blur and can be scrubbed by dragging the field sideways.
 */
export function widget(type: string, spec: WidgetSpec, value: unknown, commit: (v: unknown) => void): HTMLElement {
    const base = spec.options ? 'enum' : parseType(type).base;
    switch (base) {
        case 'number':
            return numberField(Number(value ?? spec.default ?? 0), spec, commit);

        case 'boolean': {
            const box = h('input', { type: 'checkbox', className: 'gw-check' });
            box.checked = !!value;
            box.addEventListener('change', () => commit(box.checked));
            return box;
        }

        case 'color': {
            const c = h('input', { type: 'color', className: 'gw-color', value: toHex(String(value ?? '#ffffff')) });
            c.addEventListener('input', () => commit(c.value));
            return c;
        }

        case 'enum': {
            const sel = h('select', { className: 'gw-select' },
                ...(spec.options ?? []).map((o) => h('option', { value: o }, o)));
            sel.value = String(value ?? spec.options?.[0] ?? '');
            sel.addEventListener('change', () => commit(sel.value));
            return sel;
        }

        case 'vec2': {
            const v = (value ?? spec.default ?? { x: 0, y: 0 }) as { x: number; y: number };
            const cur = { x: Number(v.x) || 0, y: Number(v.y) || 0 };
            return h('span', { className: 'gw-vec' },
                numberField(cur.x, { step: spec.step }, (x) => commit({ ...cur, x: (cur.x = x as number) })),
                numberField(cur.y, { step: spec.step }, (y) => commit({ ...cur, y: (cur.y = y as number) })));
        }

        default: {
            if (spec.multiline) {
                const ta = h('textarea', { className: 'gw-text', rows: 3 });
                ta.value = String(value ?? '');
                ta.addEventListener('change', () => commit(ta.value));
                return ta;
            }
            const inp = h('input', { type: 'text', className: 'gw-text' });
            inp.value = String(value ?? '');
            inp.addEventListener('change', () => commit(inp.value));
            inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
            return inp;
        }
    }
}

function numberField(value: number, spec: WidgetSpec, commit: (v: unknown) => void): HTMLInputElement {
    const step = spec.step ?? 1;
    const limit = (v: number) => clamp(v, spec.min ?? -Infinity, spec.max ?? Infinity);
    const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
    const inp = h('input', { type: 'text', inputMode: 'decimal', className: 'gw-num', title: 'drag sideways to scrub' });
    inp.value = fmt(value);
    let current = value;

    const set = (v: number) => {
        current = limit(v);
        inp.value = fmt(current);
        commit(current);
    };
    inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) set(v);
        else inp.value = fmt(current);
    });
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') inp.blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            set(current + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1));
        }
    });

    // scrub: drag sideways (a plain click still focuses for typing)
    inp.addEventListener('pointerdown', (e) => {
        if (document.activeElement === inp) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const start = current;
        let moved = false;
        inp.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            moved = true;
            set(start + Math.round(dx / 4) * step);
        };
        const up = () => {
            inp.removeEventListener('pointermove', move);
            inp.removeEventListener('pointerup', up);
            inp.removeEventListener('pointercancel', up);
            if (!moved) {
                inp.focus();
                inp.select();
            }
        };
        inp.addEventListener('pointermove', move);
        inp.addEventListener('pointerup', up);
        inp.addEventListener('pointercancel', up);
    });
    return inp;
}

/** <input type=color> only takes #rrggbb. */
export function toHex(color: string): string {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    if (/^#[0-9a-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map((c) => c + c).join('');
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return '#ffffff';
    ctx.fillStyle = color;
    return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : '#ffffff';
}

/**
 * Previews for your own value types (pin tooltips and node footers): return a short text, or
 * undefined to leave the value to the next previewer (and finally the built-in one).
 */
export type Previewer = (value: unknown, preview: (v: unknown) => string) => string | undefined;

const previewers: Previewer[] = [];

/** Adds a previewer, tried before the built-in previews (the last added first). */
export function addPreviewer(fn: Previewer): void {
    previewers.unshift(fn);
}

/** A short preview of a value, for pin tooltips and node footers. */
export function preview(v: unknown, list = false): string {
    if (list && Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
    for (const fn of previewers) {
        const text = fn(v, (x) => preview(x));
        if (text !== undefined) return text;
    }
    if (v === undefined) return '—';
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    if (typeof v === 'string') return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`;
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if ('x' in o && 'y' in o && Object.keys(o).length <= 3) return `(${preview(o.x)}, ${preview(o.y)})`;
    }
    return String(v);
}
