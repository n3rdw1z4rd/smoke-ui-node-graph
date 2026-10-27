import { clamp } from '@n3rdw1z4rd/core';
import {
    addNode, canConnect, collapseToSubgraph, connect, disconnect, expandSubgraph, getNode, graphId, linksInto, portTypes,
    removeNode, type GraphGroup, type GraphNode, type NodeDef, type PortRef, type SubgraphDef,
} from '@n3rdw1z4rd/core/graph';
import { chainOf } from './chain';
import { makeClip, parseClip, pasteClip, type Clip } from './clipboard';
import { h, svg } from './dom';
import { openNodeMenu } from './menu';
import type { NodeBodyPlugin } from './plugins';
import { openScriptPanel } from './script-panel';
import {
    adjustLayout, doc, docEpoch, docRevision, edit, editPath, enterSubgraph, exitSubgraph, picked, rootDoc, runtimeErrors, isScriptType, redo, registry, results, scriptsSuspended,
    scriptsTrusted, selection, typesRevision, undo,
} from './state';
import { wheelIntent } from './wheel';
import { hasWidget, preview, widget } from './widgets';

/* ------------------------------------------------------------------ */
/* The graph canvas: nodes (DOM), wires (SVG), pan / zoom, dragging     */
/* nodes and wires, selection, keys. Node views are rebuilt only when   */
/* their shape changes (links, type, flags); positions and results are  */
/* patched in place.                                                    */
/* ------------------------------------------------------------------ */

/**
 * A run this long (ms) marks a node as a likely bottleneck — half a 60 fps frame. Animated
 * nodes run every frame while playing, so they get a tighter budget.
 */
export const SLOW_MS = 8;
export const SLOW_ANIMATED_MS = 4;

/** A node's state, shown by its border color. */
export type NodeState = 'ok' | 'error' | 'slow' | 'skipped' | 'none';

const STATE_TEXT: Record<NodeState, string> = {
    ok: 'ran fine',
    error: 'error',
    slow: 'slow — a likely bottleneck',
    skipped: 'skipped',
    none: 'inside a subgraph: its results show on the subgraph node',
};

/** Node header tints by category (the part before a `/`); add your own with `categoryColors`. */
export const DEFAULT_CATEGORY_COLORS: Record<string, string> = {
    value: '#3fd1a4', math: '#4ea8de', vec2: '#4ea8de', list: '#9b6dde', output: '#e86fb0', scripts: '#d3d3d3',
    custom: '#d3d3d3', subgraph: '#9aa7ff',
};

export interface CanvasOptions {
    /** custom node bodies (live views and such) for some node types */
    plugins?: readonly NodeBodyPlugin[];
    /** header tints for your node categories, on top of the defaults */
    categoryColors?: Record<string, string>;
}

interface NodeView {
    el: HTMLElement;
    key: string;
    pins: Map<string, HTMLElement>;
    foot: HTMLElement;
}

type Drag =
    | { kind: 'pan'; last: { x: number; y: number } }
    | { kind: 'nodes'; last: { x: number; y: number }; moved: boolean }
    | { kind: 'wire'; from: PortRef; path: SVGPathElement; color: string }
    | { kind: 'resize'; node: string; start: { x: number; y: number }; size: [number, number] }
    /** a selection box: from `start` (client px); `base` is what was selected before (shift adds) */
    | { kind: 'box'; start: { x: number; y: number }; base: Set<string>; el: HTMLElement }
    /** moving a group by its header: the group and the nodes inside it */
    | { kind: 'group'; id: string; last: { x: number; y: number }; members: string[]; moved: boolean }
    | { kind: 'group-resize'; id: string; start: { x: number; y: number }; rect: [number, number, number, number] };

/** frame colors for groups (muted, like a smoked panel) */
const GROUP_COLORS = ['#3a4a3a', '#3a3f52', '#523a3a', '#524a32', '#45385a', '#2f4f52', '#3a3a3a'];

export class GraphCanvas {
    readonly el: HTMLElement;
    private readonly layer: HTMLElement;
    private readonly wires: SVGSVGElement;
    private readonly views = new Map<string, NodeView>();
    /** nodes with a plugin body (they may live on in the subgraph preview) */
    private readonly bodies = new Map<string, NodeBodyPlugin>();
    private readonly plugins: readonly NodeBodyPlugin[];
    private readonly categoryColors: Record<string, string>;
    private view = { x: 40, y: 40, zoom: 0.8 };
    private drag: Drag | null = null;
    private selectedLink: string | null = null;
    private readonly pointers = new Map<number, { x: number; y: number }>();
    private pinchDist = 0;
    private wiresQueued = false;
    private readonly groupViews = new Map<string, HTMLElement>();
    private readonly selbar: HTMLElement;
    /** the last pointer position over the canvas (graph units): where paste puts things */
    private pointer: [number, number] = [0, 0];
    /** what was copied last (a fallback when the system clipboard isn't available) */
    private clip: Clip | null = null;
    private longPress = 0;
    private readonly crumbs: HTMLElement;
    /** while inside a subgraph: top-level plugin bodies (live views) keep showing here */
    private readonly preview: HTMLElement;
    /** wires along the selection's chain */
    private chainLinks = new Set<string>();
    /** the view (pan / zoom) at each level, so going in and out keeps your place */
    private readonly levelViews = new Map<string, { x: number; y: number; zoom: number }>();
    /** nodes change size as fonts load and widgets settle: their pins move, so the wires follow */
    private readonly nodeSizes = new ResizeObserver(() => this.drawWires());

    constructor(options: CanvasOptions = {}) {
        this.plugins = options.plugins ?? [];
        this.categoryColors = { ...DEFAULT_CATEGORY_COLORS, ...options.categoryColors };
        this.wires = svg('svg', { class: 'graph-wires' });
        this.layer = h('div', { className: 'graph-layer' }, this.wires as unknown as Node);
        this.selbar = h('div', { className: 'graph-selbar', hidden: true });
        this.crumbs = h('nav', { className: 'graph-crumbs', hidden: true });
        this.preview = h('div', { className: 'graph-preview', hidden: true });
        this.el = h('div', { className: 'graph', tabIndex: 0 }, this.layer, this.selbar, this.crumbs, this.preview);

        this.attachInput();
        docRevision.subscribe(() => this.render());
        docEpoch.subscribe(() => this.render(true));
        let level = '';
        editPath.subscribe((path) => {
            // keep a view per level; a level visited for the first time is framed
            this.levelViews.set(level, { ...this.view });
            level = path.join('/');
            const saved = this.levelViews.get(level);
            if (saved) {
                this.view = { ...saved };
                this.applyView();
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => this.fit()));
            }
            this.showCrumbs();
        });
        typesRevision.subscribe(() => this.render(true));
        results.subscribe(() => this.showResults());
        scriptsSuspended.subscribe(() => this.showResults());
        runtimeErrors.subscribe(() => this.showResults());
        picked.subscribe(() => this.showResults());
        selection.subscribe((sel) => {
            const p = picked.get();
            if (p && !sel.has(p.node)) picked.set(null);
            this.markSelection();
            this.showSelbar();
            this.showResults();
        });
        new ResizeObserver(() => this.drawWires()).observe(this.el);
        void document.fonts?.ready.then(() => this.drawWires());
        this.applyView();
    }

    /* ── coordinates ───────────────────────────────────────────── */

    /** screen (client) px → graph units */
    toGraph(cx: number, cy: number): [number, number] {
        const r = this.el.getBoundingClientRect();
        return [(cx - r.left - this.view.x) / this.view.zoom, (cy - r.top - this.view.y) / this.view.zoom];
    }

    private applyView(): void {
        const { x, y, zoom } = this.view;
        this.layer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        this.el.style.setProperty('--zoom', String(zoom));
        this.el.style.backgroundPosition = `${x}px ${y}px`;
        this.el.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    }

    private zoomAt(cx: number, cy: number, factor: number): void {
        const r = this.el.getBoundingClientRect();
        const px = cx - r.left;
        const py = cy - r.top;
        const z = clamp(this.view.zoom * factor, 0.15, 2.5);
        this.view.x = px - ((px - this.view.x) * z) / this.view.zoom;
        this.view.y = py - ((py - this.view.y) * z) / this.view.zoom;
        this.view.zoom = z;
        this.applyView();
    }

    /** Frames every node. */
    fit(): void {
        if (!doc.nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of doc.nodes) {
            const v = this.views.get(n.id);
            const w = v ? v.el.offsetWidth : 200;
            const ht = v ? v.el.offsetHeight : 100;
            minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]);
            maxX = Math.max(maxX, n.pos[0] + w); maxY = Math.max(maxY, n.pos[1] + ht);
        }
        const r = this.el.getBoundingClientRect();
        const pad = 60;
        // don't zoom out so far that nodes become unreadable. A graph too wide to fit keeps its
        // right side in view — that's usually where the output is
        const z = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)), 0.75, 1.2);
        const fitsX = (maxX - minX) * z <= r.width - pad * 2;
        const fitsY = (maxY - minY) * z <= r.height - pad * 2;
        this.view = {
            zoom: z,
            x: fitsX ? (r.width - (maxX - minX) * z) / 2 - minX * z : r.width - pad / 2 - maxX * z,
            y: fitsY ? (r.height - (maxY - minY) * z) / 2 - minY * z : pad - minY * z,
        };
        this.applyView();
    }

    /* ── rendering ─────────────────────────────────────────────── */

    private render(force = false): void {
        const alive = new Set(doc.nodes.map((n) => n.id));
        for (const [id, v] of this.views) {
            if (alive.has(id)) continue;
            this.nodeSizes.unobserve(v.el);
            v.el.remove();
            this.views.delete(id);
        }
        // plugin bodies: gone for good when their node is; while you're inside a subgraph, the
        // top level's keep showing in a floating preview
        const inside = editPath.get().length > 0;
        for (const [id, plugin] of this.bodies) {
            if (alive.has(id)) continue;
            const sized = plugin.sized?.(id);
            if (!getNode(rootDoc(), id)) {
                plugin.dispose?.(id);
                this.bodies.delete(id);
            } else if (inside && sized && sized.parentElement !== this.preview) {
                this.preview.append(sized);
            }
        }
        this.preview.hidden = !inside || !this.preview.childElementCount;

        for (const node of doc.nodes) {
            const def = registry.get(node.type);
            const key = this.shapeKey(node, def);
            let v = this.views.get(node.id);
            if (!v || force || v.key !== key) {
                const next = this.buildNode(node, def, key);
                if (v) {
                    this.nodeSizes.unobserve(v.el);
                    v.el.replaceWith(next.el);
                } else {
                    this.layer.append(next.el);
                }
                this.nodeSizes.observe(next.el);
                v = next;
                this.views.set(node.id, v);
            }
            v.el.style.transform = `translate(${node.pos[0]}px, ${node.pos[1]}px)`;
            if (node.size) {
                v.el.style.width = `${node.size[0]}px`;
                const sized = this.bodies.get(node.id)?.sized?.(node.id);
                if (sized) sized.style.height = `${node.size[1]}px`;
            }
        }
        this.renderGroups();
        this.markSelection();
        this.showSelbar();
        this.showResults();
        this.drawWires();
    }

    /* ── groups ────────────────────────────────────────────────── */

    private renderGroups(): void {
        const groups = doc.groups ?? [];
        const alive = new Set(groups.map((g) => g.id));
        for (const [id, el] of this.groupViews) {
            if (alive.has(id)) continue;
            el.remove();
            this.groupViews.delete(id);
        }
        for (const g of groups) {
            let el = this.groupViews.get(g.id);
            const key = `${g.title}|${g.color}`;
            if (!el || el.dataset.key !== key) {
                const next = this.buildGroup(g);
                next.dataset.key = key;
                if (el) el.replaceWith(next);
                else this.layer.prepend(next); // under the wires and nodes
                el = next;
                this.groupViews.set(g.id, el);
            }
            const [x, y, w, ht] = g.rect;
            el.style.transform = `translate(${x}px, ${y}px)`;
            el.style.width = `${w}px`;
            el.style.height = `${ht}px`;
        }
    }

    private buildGroup(g: GraphGroup): HTMLElement {
        const title = h('span', { className: 'ggroup-title', title: 'double-click to rename' }, g.title);
        const rename = () => {
            const input = h('input', { className: 'gw-text ggroup-rename', value: g.title });
            title.replaceWith(input);
            input.focus();
            input.select();
            let done = false;
            const commit = (save: boolean) => {
                if (done) return;
                done = true;
                const v = input.value.trim();
                if (save && v && v !== g.title) edit('group title', (d) => { this.groupById(d, g.id)!.title = v.slice(0, 60); });
                else input.replaceWith(title);
            };
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') commit(true);
                if (ev.key === 'Escape') commit(false);
            });
            input.addEventListener('blur', () => commit(true));
        };
        const head = h('header', { className: 'ggroup-head' },
            title,
            h('button', {
                className: 'gnode-btn ggroup-swatch', title: 'change color', style: { background: g.color },
                onclick: () => edit('group color', (d) => {
                    const gr = this.groupById(d, g.id)!;
                    gr.color = GROUP_COLORS[(GROUP_COLORS.indexOf(gr.color) + 1) % GROUP_COLORS.length];
                }),
            }),
            h('button', { className: 'gnode-btn', title: 'remove the group (keeps its nodes)', onclick: () => this.ungroup(g.id) }, '×'));
        // the header drags the group (capturing the pointer), so a double-click is spotted here:
        // the second press of one renames instead of dragging
        let lastDown = 0;
        head.addEventListener('pointerdown', (e) => {
            const now = performance.now();
            const second = now - lastDown < 350 && !(e.target as HTMLElement).closest('button, input');
            lastDown = now;
            if (second) {
                e.stopPropagation();
                e.preventDefault();
                lastDown = 0;
                rename();
                return;
            }
            this.startGroupDrag(e, g.id);
        });
        const grip = h('div', { className: 'gnode-resize ggroup-resize', title: 'resize' });
        grip.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const gr = this.groupById(doc, g.id);
            if (!gr) return;
            this.drag = { kind: 'group-resize', id: g.id, start: { x: e.clientX, y: e.clientY }, rect: [...gr.rect] };
            this.el.setPointerCapture(e.pointerId);
        });
        return h('div', { className: 'ggroup', dataset: { group: g.id }, style: { '--group': g.color } as any }, head, grip);
    }

    private groupById(d: typeof doc, id: string): GraphGroup | undefined {
        return d.groups?.find((g) => g.id === id);
    }

    /** A node's rectangle (graph units). */
    private nodeRect(n: GraphNode): [number, number, number, number] {
        const el = this.views.get(n.id)?.el;
        return [n.pos[0], n.pos[1], el?.offsetWidth ?? 200, el?.offsetHeight ?? 100];
    }

    /** The nodes inside a group's rectangle (their centers). */
    private groupMembers(g: GraphGroup): string[] {
        const [gx, gy, gw, gh] = g.rect;
        return doc.nodes.filter((n) => {
            const [x, y, w, ht] = this.nodeRect(n);
            const cx = x + w / 2;
            const cy = y + ht / 2;
            return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
        }).map((n) => n.id);
    }

    /** Frames the selected nodes in a new group. */
    groupSelection(): void {
        const ids = selection.get();
        const nodes = doc.nodes.filter((n) => ids.has(n.id));
        if (!nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            const [x, y, w, ht] = this.nodeRect(n);
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + ht);
        }
        const pad = 24;
        const head = 34;
        const color = GROUP_COLORS[(doc.groups?.length ?? 0) % GROUP_COLORS.length];
        edit('group', (d) => {
            d.groups = [...(d.groups ?? []), {
                id: graphId('g'), title: 'group', color,
                rect: [Math.round(minX - pad), Math.round(minY - pad - head), Math.round(maxX - minX + pad * 2), Math.round(maxY - minY + pad * 2 + head)],
            }];
        });
    }

    ungroup(id: string): void {
        edit('ungroup', (d) => {
            d.groups = (d.groups ?? []).filter((g) => g.id !== id);
        });
    }

    private startGroupDrag(e: PointerEvent, id: string): void {
        if ((e.target as HTMLElement).closest('button, input')) return;
        e.stopPropagation();
        const g = this.groupById(doc, id);
        if (!g) return;
        const members = this.groupMembers(g);
        // a press on the header selects what's inside
        selection.set(new Set(e.shiftKey ? [...selection.get(), ...members] : members));
        this.drag = { kind: 'group', id, last: { x: e.clientX, y: e.clientY }, members, moved: false };
        this.el.setPointerCapture(e.pointerId);
    }

    /* ── selection bar, clipboard ──────────────────────────────── */

    private showSelbar(): void {
        const n = [...selection.get()].filter((id) => getNode(doc, id)).length;
        this.selbar.hidden = n < 2;
        if (n < 2) return;
        const label = `${n} nodes`;
        if (this.selbar.dataset.label === label) return;
        this.selbar.dataset.label = label;
        this.selbar.replaceChildren(
            h('span', { className: 'graph-selbar-count' }, label),
            h('button', { className: 'btn', title: 'frame them in a group (⌘/ctrl+g)', onclick: () => this.groupSelection() }, 'group'),
            h('button', { className: 'btn', title: 'collapse them into one reusable node (a subgraph)', onclick: () => this.collapseSelection() }, 'subgraph'),
            h('button', { className: 'btn', title: 'duplicate (⌘/ctrl+d)', onclick: () => this.duplicateSelection() }, 'duplicate'),
            h('button', { className: 'btn', title: 'copy (⌘/ctrl+c)', onclick: () => this.copySelection() }, 'copy'),
            h('button', { className: 'btn', title: 'enable / disable (m)', onclick: () => this.toggleDisabled([...selection.get()]) }, 'disable'),
            h('button', { className: 'btn', title: 'delete (del)', onclick: () => this.deleteNodes([...selection.get()]) }, 'delete'));
    }

    /** The selection as a clip (or null if nothing is selected). */
    private selectionClip(): Clip | null {
        const ids = new Set([...selection.get()].filter((id) => getNode(doc, id)));
        return ids.size ? makeClip(doc, ids, (g) => this.groupMembers(g), rootDoc()) : null;
    }

    copySelection(): void {
        const clip = this.selectionClip();
        if (!clip) return;
        this.clip = clip;
        void navigator.clipboard?.writeText(JSON.stringify(clip)).catch(() => { /* kept in memory */ });
        this.flash(`copied ${clip.nodes.length} node${clip.nodes.length === 1 ? '' : 's'}`, true);
    }

    paste(clip: Clip | null = this.clip): void {
        if (!clip?.nodes.length) return;
        let ids: string[] = [];
        edit('paste', (d) => {
            ids = pasteClip(d, clip, [Math.round(this.pointer[0]), Math.round(this.pointer[1])]);
        });
        selection.set(new Set(ids));
    }

    /** What a node view depends on besides positions and values. */
    private shapeKey(node: GraphNode, def: NodeDef | undefined): string {
        const linked = doc.links.filter((l) => l.to.node === node.id).map((l) => l.to.port).sort().join(',');
        return [def?.type ?? '?', def?.revision ?? 0, linked, node.animate ?? '', node.disabled ?? '', node.title ?? '', node.collapsed ?? ''].join('|');
    }

    private buildNode(node: GraphNode, def: NodeDef | undefined, key: string): NodeView {
        const pins = new Map<string, HTMLElement>();
        const color = this.categoryColors[def?.category.split('/')[0] ?? ''] ?? '#808080';
        const plugin = this.pluginFor(def);
        const animated = node.animate ?? def?.animate ?? false;

        const head = h('header', { className: 'gnode-head', style: { '--cat': color } as any },
            h('span', { className: 'gnode-title', title: def ? `${def.type}${def.description ? ` — ${def.description}` : ''}` : node.type },
                node.title ?? def?.title ?? node.type),
            this.subgraphDef(node.type)
                ? h('button', { className: 'gnode-btn', title: 'go inside (double-click the header)', onclick: () => enterSubgraph(node.type) }, '⤵')
                : null,
            this.subgraphDef(node.type)
                ? h('button', { className: 'gnode-btn', title: 'expand: put its nodes back here', onclick: () => this.expand(node.id) }, '⇲')
                : null,
            def?.source && !plugin?.hideCode
                ? h('button', {
                    className: 'gnode-btn',
                    title: isScriptType(def.type) ? 'edit this node’s script' : 'view this node’s code — save it as a custom version',
                    onclick: () => void openScriptPanel({ type: def.type, nodeId: node.id }),
                }, '✎')
                : null,
            def && !def.output ? h('button', {
                className: animated ? 'gnode-btn on' : 'gnode-btn',
                title: animated ? 'animated: re-runs every frame while playing (click to stop)' : 'animate: re-run every frame while playing',
                onclick: () => edit('animate', (d) => {
                    const n = getNode(d, node.id)!;
                    n.animate = !animated;
                }),
            }, '⟳') : null,
            h('button', {
                className: node.disabled ? 'gnode-btn power' : 'gnode-btn power on',
                title: node.disabled ? 'disabled — click to enable (m)' : 'enabled — click to disable (m)',
                onclick: () => this.toggleDisabled([node.id]),
            }, '⏻'),
            h('button', { className: 'gnode-btn', title: 'delete (del)', onclick: () => this.deleteNodes([node.id]) }, '×'));
        let lastDown = 0;
        head.addEventListener('pointerdown', (e) => {
            // a double-click on a subgraph's header goes inside (the drag captures the pointer,
            // so the second press is spotted here)
            const now = performance.now();
            if (this.subgraphDef(node.type) && now - lastDown < 350 && !(e.target as HTMLElement).closest('button')) {
                e.stopPropagation();
                lastDown = 0;
                enterSubgraph(node.type);
                return;
            }
            lastDown = now;
            this.startNodeDrag(e, node.id);
        });

        const body = h('div', { className: 'gnode-body' });
        if (!def) {
            body.append(h('div', { className: 'gnode-row muted' }, `unknown type ${node.type}`));
        } else {
            // inside a subgraph: which pins are its inputs and outputs
            const sub = this.currentSubgraph();
            for (const p of def.outputs) {
                const pin = this.pin('out', node.id, p.name, p.type);
                pins.set(`out:${p.name}`, pin);
                const out = sub?.outputs.find((o) => o.from.node === node.id && o.from.port === p.name);
                body.append(h('div', { className: out ? 'gnode-row out boundary' : 'gnode-row out' },
                    h('span', { className: 'gnode-label', title: out ? `the subgraph’s output “${out.name}”` : '' }, out ? `${p.name} ⇢ ${out.name}` : p.name), pin));
            }
            for (const p of def.inputs) {
                const pin = this.pin('in', node.id, p.name, p.type, p.multi);
                pins.set(`in:${p.name}`, pin);
                const ext = sub?.inputs.find((i) => i.to.some((t) => t.node === node.id && t.port === p.name));
                const linked = linksInto(doc, node.id, p.name).length > 0;
                const w = !linked && !ext && hasWidget(p.type, p)
                    ? widget(p.type, p, node.values[p.name] ?? p.default, (v) => this.setValue(node.id, p.name, v))
                    : null;
                body.append(h('div', { className: ext ? 'gnode-row in boundary' : 'gnode-row in' }, pin,
                    h('span', { className: 'gnode-label', title: ext ? `fed by the subgraph’s input “${ext.name}”` : p.description ?? '' },
                        ext ? `${ext.name} ⇢ ${p.label ?? p.name}` : p.label ?? p.name), w));
            }
            for (const p of def.params) {
                const w = widget(p.type, p, node.values[p.name] ?? p.default, (v) => this.setValue(node.id, p.name, v));
                body.append(h('div', { className: 'gnode-row param' }, h('span', { className: 'gnode-label', title: p.description ?? '' }, p.label ?? p.name), w));
            }
            if (plugin) {
                body.append(plugin.body(node, def));
                this.bodies.set(node.id, plugin);
            }
        }

        const foot = h('footer', { className: 'gnode-foot' });
        const el = h('div', { className: def?.output ? 'gnode output' : 'gnode', dataset: { node: node.id } }, head, body, foot);
        if (node.disabled) el.dataset.disabled = '';
        if (plugin?.sized) {
            const grip = h('div', { className: 'gnode-resize', title: 'resize' });
            grip.addEventListener('pointerdown', (e) => this.startResize(e, node));
            el.append(grip);
        }
        el.addEventListener('pointerdown', (e) => {
            // a press on the body (not a widget) selects too
            if ((e.target as HTMLElement).closest('input, select, textarea, button, .gnode-pin, .graph-interactive')) return;
            if (!e.shiftKey && !selection.get().has(node.id)) selection.set(new Set([node.id]));
        });
        return { el, key, pins, foot };
    }

    private pin(dir: 'in' | 'out', node: string, port: string, type: string, multi = false): HTMLElement {
        const list = type.trim().endsWith('[]');
        const pin = h('span', {
            className: `gnode-pin ${dir}${list ? ' list' : ''}${multi ? ' multi' : ''}`,
            title: `${port}: ${type}${multi ? ' (takes several links)' : ''}`,
            style: { '--pin': portTypes.color(type) } as any,
            dataset: { dir, node, port, type },
        });
        pin.addEventListener('pointerdown', (e) => this.startWire(e, dir, node, port));
        return pin;
    }

    private setValue(nodeId: string, name: string, v: unknown): void {
        edit(`value:${nodeId}:${name}`, (d) => {
            getNode(d, nodeId)!.values[name] = v;
        });
    }

    /** Selected nodes, and the chain through them (both ways) lit up, nodes and wires. */
    private markSelection(): void {
        const sel = selection.get();
        const chain = sel.size ? chainOf(doc, sel) : { nodes: new Set<string>(), links: new Set<string>() };
        for (const [id, v] of this.views) {
            v.el.classList.toggle('selected', sel.has(id));
            v.el.classList.toggle('chain', !sel.has(id) && chain.nodes.has(id));
        }
        const changed = chain.links.size !== this.chainLinks.size || [...chain.links].some((l) => !this.chainLinks.has(l));
        this.chainLinks = chain.links;
        if (changed) this.drawWires();
    }

    private pluginFor(def: NodeDef | undefined): NodeBodyPlugin | undefined {
        return def ? this.plugins.find((p) => p.types.includes(def.type)) : undefined;
    }

    private showResults(): void {
        const res = results.get();
        const pausedScripts = scriptsSuspended.get() || !scriptsTrusted.get();
        for (const [id, v] of this.views) {
            const r = res.get(id);
            const node = getNode(doc, id);
            const def = node && registry.get(node.type);
            const animated = !!(node && (node.animate ?? def?.animate));
            const paused = !!def && isScriptType(def.type) && pausedScripts;

            // state → border color; skipping propagates (blocked = an upstream node failed or was skipped)
            let state: NodeState;
            let text = '';
            if (node?.disabled) {
                state = 'skipped';
                text = 'disabled';
            } else if (!r && editPath.get().length) {
                state = 'none'; // inside a subgraph: results show on the subgraph node
                text = '';
            } else if (!r) {
                state = 'skipped';
                text = def?.output ? '' : 'skipped — nothing it feeds is shown';
            } else if (paused && r.error) {
                state = 'skipped';
                text = scriptsSuspended.get() ? 'skipped — script nodes are paused' : 'skipped — the graph’s scripts aren’t trusted yet';
            } else if (r.blocked) {
                state = 'skipped';
                const up = getNode(doc, r.blocked);
                const name = up ? (up.title ?? registry.get(up.type)?.title ?? up.type) : 'an upstream node';
                text = up?.disabled ? `skipped — ${name} is disabled` : `skipped — waiting on ${name}`;
            } else if (r.error) {
                state = 'error';
                text = r.error;
            } else if (runtimeErrors.get().has(id)) {
                state = 'error';
                text = `while playing: ${runtimeErrors.get().get(id)}`;
            } else {
                state = r.ms >= (animated ? SLOW_ANIMATED_MS : SLOW_MS) ? 'slow' : 'ok';
                const parts: string[] = [];
                if (def && def.outputs.length) {
                    const first = def.outputs[0];
                    const out = r.outputs[first.name];
                    // picked elsewhere (e.g. clicked in a view): which of its items
                    const p = picked.get();
                    if (p?.node === id && r.lists[first.name] && Array.isArray(out)) parts.push(`item ${p.index + 1} of ${out.length}`);
                    else parts.push(preview(out, r.lists[first.name]));
                }
                if (r.ms >= 0.05) parts.push(`${r.ms.toFixed(1)} ms${state === 'slow' ? ' ⚠' : ''}`);
                if (r.skipped?.length) parts.push(`${r.skipped.length} input${r.skipped.length === 1 ? '' : 's'} skipped`);
                text = parts.join(' · ');
            }

            if (v.el.dataset.state !== state) {
                v.el.dataset.state = state;
                v.el.title = STATE_TEXT[state];
            }
            if (v.foot.textContent !== text) v.foot.textContent = text;
            if (def && r && !r.error) {
                for (const p of def.outputs) {
                    const pin = v.pins.get(`out:${p.name}`);
                    if (pin) pin.title = `${p.name}: ${p.type} = ${preview(r.outputs[p.name], r.lists[p.name])}`;
                }
            }
        }
        for (const plugin of this.plugins) plugin.refresh?.();
    }

    /* ── wires ─────────────────────────────────────────────────── */

    private pinCenter(pin: HTMLElement): [number, number] {
        const r = pin.getBoundingClientRect();
        const l = this.layer.getBoundingClientRect();
        return [(r.left + r.width / 2 - l.left) / this.view.zoom, (r.top + r.height / 2 - l.top) / this.view.zoom];
    }

    /** Redraws every wire on the next frame. */
    drawWires(): void {
        if (this.wiresQueued) return;
        this.wiresQueued = true;
        requestAnimationFrame(() => {
            this.wiresQueued = false;
            this.drawWiresNow();
        });
    }

    private drawWiresNow(): void {
        const keep = this.drag?.kind === 'wire' ? this.drag.path : null;
        this.wires.replaceChildren(...(keep ? [keep] : []));
        for (const l of doc.links) {
            const a = this.views.get(l.from.node)?.pins.get(`out:${l.from.port}`);
            const b = this.views.get(l.to.node)?.pins.get(`in:${l.to.port}`);
            if (!a || !b) continue;
            const type = a.dataset.type ?? 'any';
            const cls = l.id === this.selectedLink ? 'wire selected' : this.chainLinks.has(l.id) ? 'wire chain' : 'wire';
            const path = svg('path', { class: cls, d: curve(this.pinCenter(a), this.pinCenter(b)) });
            path.style.setProperty('--pin', portTypes.color(type));
            path.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.selectedLink = l.id;
                selection.set(new Set());
                this.drawWires();
            });
            this.wires.prepend(path);
        }
    }

    private startWire(e: PointerEvent, dir: 'in' | 'out', node: string, port: string): void {
        e.stopPropagation();
        e.preventDefault();
        let from: PortRef = { node, port };
        if (dir === 'in') {
            // pick up the input's (last) link and re-route it from its source
            const links = linksInto(doc, node, port);
            const link = links[links.length - 1];
            if (!link) return;
            from = link.from;
            edit('disconnect', (d) => disconnect(d, link.id));
        }
        const fromNode = getNode(doc, from.node)!;
        const type = registry.get(fromNode.type)?.outputs.find((p) => p.name === from.port)?.type ?? 'any';
        const color = portTypes.color(type);
        const path = svg('path', { class: 'wire dragging' });
        path.style.setProperty('--pin', color);
        this.wires.append(path);
        this.drag = { kind: 'wire', from, path, color };
        this.el.setPointerCapture(e.pointerId);
        this.el.classList.add('wiring');

        // light up the inputs this can connect to
        for (const [id, v] of this.views) {
            for (const [key, pin] of v.pins) {
                if (!key.startsWith('in:')) continue;
                const ok = canConnect(doc, registry, from, { node: id, port: key.slice(3) }).ok;
                pin.classList.toggle('can', ok);
            }
        }
        this.moveWire(e.clientX, e.clientY);
    }

    private moveWire(cx: number, cy: number): void {
        if (this.drag?.kind !== 'wire') return;
        const a = this.views.get(this.drag.from.node)?.pins.get(`out:${this.drag.from.port}`);
        if (!a) return;
        this.drag.path.setAttribute('d', curve(this.pinCenter(a), this.toGraph(cx, cy)));
    }

    private endWire(cx: number, cy: number): void {
        if (this.drag?.kind !== 'wire') return;
        const { from } = this.drag;
        this.drag.path.remove();
        this.drag = null;
        this.el.classList.remove('wiring');
        for (const v of this.views.values()) for (const pin of v.pins.values()) pin.classList.remove('can');

        const target = (document.elementFromPoint(cx, cy) as HTMLElement | null)?.closest<HTMLElement>('.gnode-pin.in');
        if (target) {
            const to = { node: target.dataset.node!, port: target.dataset.port! };
            const check = canConnect(doc, registry, from, to);
            if (check.ok) edit('connect', (d) => connect(d, registry, from, to));
            else this.flash(check.reason);
            return;
        }
        // dropped on empty canvas: pick a node to connect to
        const at = this.toGraph(cx, cy);
        openNodeMenu(this.el, cx, cy, (def) => {
            edit('add node', (d) => {
                const n = addNode(d, def, [at[0], at[1] - 20]);
                const fromType = registry.get(getNode(d, from.node)!.type)?.outputs.find((p) => p.name === from.port)?.type ?? 'any';
                const input = def.inputs.find((p) => portTypes.canConnect(fromType, p.type));
                if (input) connect(d, registry, from, { node: n.id, port: input.name });
                selection.set(new Set([n.id]));
            });
        }, { fromType: registry.get(getNode(doc, from.node)!.type)?.outputs.find((p) => p.name === from.port)?.type, exclude: this.menuExclude });
    }

    /* ── nodes ─────────────────────────────────────────────────── */

    private startNodeDrag(e: PointerEvent, id: string): void {
        if ((e.target as HTMLElement).closest('button')) return;
        e.stopPropagation();
        const sel = new Set(selection.get());
        if (e.shiftKey) {
            if (sel.has(id)) sel.delete(id);
            else sel.add(id);
        } else if (!sel.has(id)) {
            sel.clear();
            sel.add(id);
        }
        selection.set(sel);
        this.selectedLink = null;
        this.drag = { kind: 'nodes', last: { x: e.clientX, y: e.clientY }, moved: false };
        this.el.setPointerCapture(e.pointerId);
    }

    private startResize(e: PointerEvent, node: GraphNode): void {
        e.stopPropagation();
        e.preventDefault();
        const sized = this.bodies.get(node.id)?.sized?.(node.id);
        const size: [number, number] = node.size ?? [this.views.get(node.id)!.el.offsetWidth, sized?.offsetHeight ?? 300];
        this.drag = { kind: 'resize', node: node.id, start: { x: e.clientX, y: e.clientY }, size };
        this.el.setPointerCapture(e.pointerId);
    }

    /** Disables the nodes, or enables them all if they're all disabled already. */
    toggleDisabled(ids: string[]): void {
        if (!ids.length) return;
        const enable = ids.every((id) => getNode(doc, id)?.disabled);
        edit('enable', (d) => {
            for (const id of ids) {
                const n = getNode(d, id);
                if (!n) continue;
                if (enable) delete n.disabled;
                else n.disabled = true;
            }
        });
    }

    deleteNodes(ids: string[]): void {
        if (!ids.length) return;
        edit('delete', (d) => {
            for (const id of ids) removeNode(d, id);
        });
        selection.set(new Set());
    }

    duplicateSelection(): void {
        const clip = this.selectionClip();
        if (!clip) return;
        let minX = Infinity, minY = Infinity;
        for (const n of clip.nodes) {
            minX = Math.min(minX, n.pos[0]);
            minY = Math.min(minY, n.pos[1]);
        }
        for (const g of clip.groups ?? []) {
            minX = Math.min(minX, g.rect[0]);
            minY = Math.min(minY, g.rect[1]);
        }
        let ids: string[] = [];
        edit('duplicate', (d) => {
            ids = pasteClip(d, clip, [minX + 40, minY + 40]);
        });
        selection.set(new Set(ids));
    }

    /**
     * Tidies a hand-laid-out graph (the examples) once nodes have their real sizes: nodes at
     * about the same x form a column; columns are spaced by their widest node, and each
     * column is stacked top-down with a gap, so nothing overlaps whatever the font size.
     * Not an undo step: it's part of what was just loaded.
     */
    unstack(gap = 28): void {
        const boxes = doc.nodes.map((n) => {
            const el = this.views.get(n.id)?.el;
            return { n, w: el?.offsetWidth ?? 200, h: el?.offsetHeight ?? 100 };
        }).sort((a, b) => a.n.pos[0] - b.n.pos[0]);

        const columns: (typeof boxes)[] = [];
        for (const b of boxes) {
            const col = columns[columns.length - 1];
            if (col && b.n.pos[0] - col[0].n.pos[0] < 60) col.push(b);
            else columns.push([b]);
        }

        let moved = false;
        let right = -Infinity;
        for (const col of columns) {
            const x = Math.max(col[0].n.pos[0], right + gap * 2);
            const width = Math.max(...col.map((b) => b.w));
            col.sort((a, b) => a.n.pos[1] - b.n.pos[1]);
            let bottom = -Infinity;
            for (const b of col) {
                const y = Math.max(b.n.pos[1], bottom + gap);
                if (b.n.pos[0] !== x || b.n.pos[1] !== y) {
                    b.n.pos = [x, y];
                    moved = true;
                }
                bottom = y + b.h;
            }
            right = x + width;
        }
        if (moved) adjustLayout();
    }

    /* ── subgraphs ─────────────────────────────────────────────── */

    private subgraphDef(type: string): SubgraphDef | undefined {
        return rootDoc().subgraphs?.[type];
    }

    /** The subgraph being edited (null at the top level). */
    private currentSubgraph(): SubgraphDef | null {
        const path = editPath.get();
        return path.length ? this.subgraphDef(path[path.length - 1]) ?? null : null;
    }

    /** Whether `type` is, or contains (all the way down), a subgraph we're inside of. */
    private wouldNest(type: string): boolean {
        const path = new Set(editPath.get());
        const seen = new Set<string>();
        const visit = (t: string): boolean => {
            if (path.has(t)) return true;
            const def = this.subgraphDef(t);
            if (!def || seen.has(t)) return false;
            seen.add(t);
            return def.nodes.some((n) => visit(n.type));
        };
        return visit(type);
    }

    /** What the node menu leaves out here. */
    private menuExclude = (def: NodeDef): boolean =>
        editPath.get().length > 0 && (def.output || this.wouldNest(def.type));

    collapseSelection(): void {
        const ids = [...selection.get()].filter((id) => getNode(doc, id));
        if (!ids.length) return;
        let made: GraphNode | null = null;
        try {
            edit('subgraph', (d) => {
                made = collapseToSubgraph(d, registry, ids, 'Subgraph').node;
            });
        } catch (err) {
            this.flash((err as Error).message);
            return;
        }
        if (made) selection.set(new Set([(made as GraphNode).id]));
    }

    expand(nodeId: string): void {
        let ids: string[] = [];
        edit('expand', (d) => {
            ids = expandSubgraph(d, nodeId, rootDoc().subgraphs);
        });
        selection.set(new Set(ids));
    }

    private showCrumbs(): void {
        const path = editPath.get();
        this.crumbs.hidden = !path.length;
        if (!path.length) return;
        const items: (HTMLElement | string)[] = [h('button', { className: 'crumb', title: 'back to the top level', onclick: () => exitSubgraph(0) }, 'graph')];
        path.forEach((type, i) => {
            items.push(h('span', { className: 'crumb-sep' }, '›'));
            const def = this.subgraphDef(type);
            const last = i === path.length - 1;
            const b = h('button', {
                className: last ? 'crumb current' : 'crumb',
                title: last ? `${type} — double-click to rename · esc goes back out` : `back to ${def?.title ?? type}`,
                onclick: () => !last && exitSubgraph(i + 1),
            }, def?.title ?? type);
            if (last) {
                b.addEventListener('dblclick', () => {
                    const input = h('input', { className: 'gw-text', value: def?.title ?? '' });
                    b.replaceWith(input);
                    input.focus();
                    input.select();
                    let done = false;
                    const commit = (save: boolean) => {
                        if (done) return;
                        done = true;
                        const v = input.value.trim().slice(0, 60);
                        if (save && v && def && v !== def.title) edit('rename subgraph', () => { rootDoc().subgraphs![type].title = v; });
                        this.showCrumbs();
                    };
                    input.addEventListener('keydown', (ev) => {
                        ev.stopPropagation();
                        if (ev.key === 'Enter') commit(true);
                        if (ev.key === 'Escape') commit(false);
                    });
                    input.addEventListener('blur', () => commit(true));
                });
            }
            items.push(b);
        });
        items.push(h('span', { className: 'crumb-note' }, 'editing a subgraph: every node of this type follows'));
        this.crumbs.replaceChildren(...items);
    }

    /** Opens the add-node menu at a client point. */
    addNodeAt(cx: number, cy: number): void {
        const at = this.toGraph(cx, cy);
        openNodeMenu(this.el, cx, cy, (def) => {
            edit('add node', (d) => {
                const n = addNode(d, def, at);
                const size = this.pluginFor(def)?.defaultSize;
                if (size) n.size = [...size];
                selection.set(new Set([n.id]));
            });
        }, { exclude: this.menuExclude });
    }

    /* ── input ─────────────────────────────────────────────────── */

    private attachInput(): void {
        const el = this.el;

        el.addEventListener('pointerdown', (e) => {
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.drag) return;
            const onBackground = e.target === el || e.target === this.layer || e.target === this.wires;
            if (this.pointers.size === 2) {
                // second finger: pinch / pan the canvas
                const [a, b] = [...this.pointers.values()];
                this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                this.drag = { kind: 'pan', last: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
                return;
            }
            // shift / ⌘ / ctrl + drag on empty canvas: a selection box (shift adds to the selection)
            if (onBackground && e.button === 0 && e.pointerType !== 'touch' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                this.startBox(e.clientX, e.clientY, e.shiftKey);
                el.setPointerCapture(e.pointerId);
                return;
            }
            if (onBackground && e.pointerType === 'touch') {
                // touch: hold still for a moment, then drag, for a selection box
                clearTimeout(this.longPress);
                const at = { x: e.clientX, y: e.clientY };
                this.longPress = window.setTimeout(() => {
                    const p = this.pointers.get(e.pointerId);
                    if (this.drag?.kind !== 'pan' || this.pointers.size !== 1 || !p || Math.hypot(p.x - at.x, p.y - at.y) > 8) return;
                    navigator.vibrate?.(10);
                    el.classList.remove('panning');
                    this.startBox(p.x, p.y, false);
                }, 450);
            }
            if (onBackground || e.button === 1) {
                if (onBackground && e.button === 0 && !e.shiftKey) {
                    selection.set(new Set());
                    if (this.selectedLink) {
                        this.selectedLink = null;
                        this.drawWires();
                    }
                }
                el.focus({ preventScroll: true });
                this.drag = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
                el.setPointerCapture(e.pointerId);
                el.classList.add('panning');
            }
        });

        el.addEventListener('pointermove', (e) => {
            if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            this.pointer = this.toGraph(e.clientX, e.clientY);
            const d = this.drag;
            if (!d) return;
            switch (d.kind) {
                case 'box':
                    this.moveBox(e.clientX, e.clientY);
                    break;
                case 'group': {
                    const dx = (e.clientX - d.last.x) / this.view.zoom;
                    const dy = (e.clientY - d.last.y) / this.view.zoom;
                    d.last = { x: e.clientX, y: e.clientY };
                    if (!dx && !dy) break;
                    d.moved = true;
                    const members = new Set(d.members);
                    edit('move', (doc) => {
                        const g = this.groupById(doc, d.id);
                        if (g) g.rect = [g.rect[0] + dx, g.rect[1] + dy, g.rect[2], g.rect[3]];
                        for (const n of doc.nodes) if (members.has(n.id)) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
                    });
                    break;
                }
                case 'group-resize': {
                    const w = Math.max(160, d.rect[2] + (e.clientX - d.start.x) / this.view.zoom);
                    const ht = Math.max(80, d.rect[3] + (e.clientY - d.start.y) / this.view.zoom);
                    edit(`resize:${d.id}`, (doc) => {
                        const g = this.groupById(doc, d.id);
                        if (g) g.rect = [g.rect[0], g.rect[1], Math.round(w), Math.round(ht)];
                    });
                    break;
                }
                case 'pan': {
                    if (this.pointers.size >= 2) {
                        const [a, b] = [...this.pointers.values()];
                        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                        const dist = Math.hypot(a.x - b.x, a.y - b.y);
                        this.view.x += c.x - d.last.x;
                        this.view.y += c.y - d.last.y;
                        if (this.pinchDist) this.zoomAt(c.x, c.y, dist / this.pinchDist);
                        this.pinchDist = dist;
                        d.last = c;
                    } else {
                        this.view.x += e.clientX - d.last.x;
                        this.view.y += e.clientY - d.last.y;
                        d.last = { x: e.clientX, y: e.clientY };
                    }
                    this.applyView();
                    break;
                }
                case 'nodes': {
                    const dx = (e.clientX - d.last.x) / this.view.zoom;
                    const dy = (e.clientY - d.last.y) / this.view.zoom;
                    d.last = { x: e.clientX, y: e.clientY };
                    if (!dx && !dy) break;
                    d.moved = true;
                    const ids = selection.get();
                    edit('move', (doc) => {
                        for (const n of doc.nodes) if (ids.has(n.id)) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
                    });
                    break;
                }
                case 'wire':
                    this.moveWire(e.clientX, e.clientY);
                    break;
                case 'resize': {
                    const w = Math.max(240, d.size[0] + (e.clientX - d.start.x) / this.view.zoom);
                    const ht = Math.max(140, d.size[1] + (e.clientY - d.start.y) / this.view.zoom);
                    edit(`resize:${d.node}`, (doc) => {
                        getNode(doc, d.node)!.size = [Math.round(w), Math.round(ht)];
                    });
                    break;
                }
            }
        });

        const up = (e: PointerEvent) => {
            this.pointers.delete(e.pointerId);
            this.pinchDist = 0;
            const d = this.drag;
            if (!d) return;
            if (d.kind === 'wire') this.endWire(e.clientX, e.clientY);
            if (d.kind === 'pan' && this.pointers.size > 0) return; // one finger still down
            clearTimeout(this.longPress);
            this.drag = null;
            el.classList.remove('panning');
            if (d.kind === 'box') d.el.remove();
            if (d.kind === 'group' && d.moved) {
                const members = new Set(d.members);
                edit('move', (doc) => {
                    const g = this.groupById(doc, d.id);
                    if (!g) return;
                    const sx = Math.round(g.rect[0] / 8) * 8 - g.rect[0];
                    const sy = Math.round(g.rect[1] / 8) * 8 - g.rect[1];
                    g.rect = [g.rect[0] + sx, g.rect[1] + sy, g.rect[2], g.rect[3]];
                    for (const n of doc.nodes) if (members.has(n.id)) n.pos = [n.pos[0] + sx, n.pos[1] + sy];
                });
            }
            if (d.kind === 'nodes' && d.moved) {
                // snap to an 8-unit grid when the drag ends
                const ids = selection.get();
                edit('move', (doc) => {
                    for (const n of doc.nodes) if (ids.has(n.id)) n.pos = [Math.round(n.pos[0] / 8) * 8, Math.round(n.pos[1] / 8) * 8];
                });
            }
        };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);

        // copy / cut / paste: the system clipboard events (no permission prompt; works across tabs)
        const typing = () => {
            const t = document.activeElement as HTMLElement | null;
            return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || !!t.closest('.cm-editor, .script-panel, .node-menu'));
        };
        document.addEventListener('copy', (e) => {
            if (typing()) return;
            const clip = this.selectionClip();
            if (!clip) return;
            this.clip = clip;
            e.clipboardData?.setData('text/plain', JSON.stringify(clip));
            e.preventDefault();
        });
        document.addEventListener('cut', (e) => {
            if (typing()) return;
            const clip = this.selectionClip();
            if (!clip) return;
            this.clip = clip;
            e.clipboardData?.setData('text/plain', JSON.stringify(clip));
            e.preventDefault();
            this.deleteNodes(clip.nodes.map((n) => n.id));
        });
        document.addEventListener('paste', (e) => {
            if (typing()) return;
            const clip = parseClip(e.clipboardData?.getData('text/plain') ?? '') ?? this.clip;
            if (!clip) return;
            e.preventDefault();
            this.paste(clip);
        });

        el.addEventListener('wheel', (e) => {
            if ((e.target as HTMLElement).closest('.graph-interactive, textarea, select')) return;
            e.preventDefault();
            const w = wheelIntent(e);
            if (w.kind === 'pan') {
                this.view.x -= w.dx;
                this.view.y -= w.dy;
                this.applyView();
            } else {
                this.zoomAt(e.clientX, e.clientY, w.factor);
            }
        }, { passive: false });

        el.addEventListener('dblclick', (e) => {
            if (e.target === el || e.target === this.layer || e.target === this.wires) this.addNodeAt(e.clientX, e.clientY);
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (e.target === el || e.target === this.layer || e.target === this.wires) this.addNodeAt(e.clientX, e.clientY);
        });

        window.addEventListener('keydown', (e) => {
            const t = e.target as HTMLElement | null;
            if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest('.cm-editor, .script-panel, .node-menu'))) return;
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
            } else if (mod && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redo();
            } else if (mod && e.key.toLowerCase() === 'd') {
                e.preventDefault();
                this.duplicateSelection();
            } else if (mod && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                this.groupSelection();
            } else if (mod && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                selection.set(new Set(doc.nodes.map((n) => n.id)));
            } else if (e.key === 'Escape') {
                if (!selection.get().size && editPath.get().length) exitSubgraph();
                else selection.set(new Set());
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedLink) {
                    const id = this.selectedLink;
                    this.selectedLink = null;
                    edit('disconnect', (d) => disconnect(d, id));
                } else {
                    this.deleteNodes([...selection.get()]);
                }
            } else if (e.key === 'f') {
                this.fit();
            } else if (e.key === 'm' && !mod) {
                this.toggleDisabled([...selection.get()]);
            } else if (e.key === 'a' && !mod) {
                const r = this.el.getBoundingClientRect();
                this.addNodeAt(r.left + r.width / 2, r.top + r.height / 3);
            } else {
                return;
            }
            e.preventDefault();
        });
    }

    private startBox(cx: number, cy: number, add: boolean): void {
        const box = h('div', { className: 'graph-marquee' });
        this.el.append(box);
        this.drag = { kind: 'box', start: { x: cx, y: cy }, base: add ? new Set(selection.get()) : new Set(), el: box };
        this.moveBox(cx, cy);
    }

    /** Updates the selection box and selects every node it touches. */
    private moveBox(cx: number, cy: number): void {
        if (this.drag?.kind !== 'box') return;
        const { start, base, el } = this.drag;
        const r = this.el.getBoundingClientRect();
        const left = Math.min(start.x, cx), top = Math.min(start.y, cy);
        Object.assign(el.style, {
            left: `${left - r.left}px`, top: `${top - r.top}px`,
            width: `${Math.abs(cx - start.x)}px`, height: `${Math.abs(cy - start.y)}px`,
        });
        const [x0, y0] = this.toGraph(left, top);
        const [x1, y1] = this.toGraph(Math.max(start.x, cx), Math.max(start.y, cy));
        const picked = new Set(base);
        for (const n of doc.nodes) {
            const [x, y, w, ht] = this.nodeRect(n);
            if (x < x1 && x + w > x0 && y < y1 && y + ht > y0) picked.add(n.id);
        }
        const cur = selection.get();
        if (picked.size !== cur.size || [...picked].some((id) => !cur.has(id))) selection.set(picked);
    }

    private flash(message: string, ok = false): void {
        const tip = h('div', { className: ok ? 'graph-flash ok' : 'graph-flash' }, message);
        this.el.append(tip);
        setTimeout(() => tip.remove(), 1600);
    }
}

/** A wire from an output (a) to an input (b): a horizontal S-curve. */
function curve([x1, y1]: [number, number], [x2, y2]: [number, number]): string {
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
