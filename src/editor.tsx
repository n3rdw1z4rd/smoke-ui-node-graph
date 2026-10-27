import { computed } from '@n3rdw1z4rd/smoke-ui';
import { addNode } from '@n3rdw1z4rd/core/graph';
import { GraphCanvas, type CanvasOptions } from './canvas';
import { openScriptPanel, setScriptAddHandler } from './script-panel';
import {
    boot, edit, exportGraph, importGraph, redo, registry, reset, resumeScripts, scriptsSuspended, scriptsTrusted, selection,
    status, trustScripts, undo,
} from './state';

/* ------------------------------------------------------------------ */
/* The editor: a toolbar, the trust / paused banners, the canvas and    */
/* a help bar. configure() first (your nodes and evaluation worker).    */
/* ------------------------------------------------------------------ */

export interface GraphEditorOptions extends CanvasOptions {
    /** the name at the left of the toolbar */
    brand?: { label: string; href?: string; title?: string };
    /** your own toolbar items, at the right end (after the status text) */
    toolbarEnd?: () => (Node | string)[];
    /** the reset button's tooltip */
    resetTitle?: string;
    /** the help bar's text (after the state legend). Default: the mouse actions */
    help?: string;
}

export interface GraphEditor {
    /** the whole editor: put it in the page */
    readonly el: HTMLElement;
    readonly canvas: GraphCanvas;
    /** loads the autosaved graph (or the initial one) and frames it */
    start(): void;
    /** after a graph loads: once nodes have their real sizes, pulls overlapping ones apart, then frames them */
    settle(): void;
}

export const DEFAULT_HELP = 'drag empty space to pan · shift-drag to select · scroll to pan · pinch or ⌘-scroll to zoom · drag from a pin to wire · double-click or right-click to add a node';

/** Builds the editor (after `configure()`). */
export function createGraphEditor(options: GraphEditorOptions = {}): GraphEditor {
    const canvas = new GraphCanvas(options);

    const settle = (): void => {
        requestAnimationFrame(() => requestAnimationFrame(async () => {
            await document.fonts?.ready;
            canvas.unstack();
            requestAnimationFrame(() => canvas.fit());
        }));
    };

    setScriptAddHandler((type) => {
        const def = registry.get(type);
        if (!def) return;
        const r = canvas.el.getBoundingClientRect();
        const [x, y] = canvas.toGraph(r.left + r.width / 2, r.top + r.height / 2);
        edit('add node', (d) => {
            const n = addNode(d, def, [x, y]);
            selection.set(new Set([n.id]));
        });
    });

    const pickImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = () => {
            const f = input.files?.[0];
            if (f) importGraph(f).then(settle, (err) => status.set(`import failed: ${(err as Error).message}`));
        };
        input.click();
    };

    const brand = options.brand;
    const toolbar = (
        <nav className="graph-bar">
            {brand ? <a className="graph-brand" href={brand.href ?? './'} title={brand.title ?? brand.label}>{brand.label}</a> : null}
            <button className="btn" title="add a node (a, double-click or right-click the canvas)" onClick={() => {
                const r = canvas.el.getBoundingClientRect();
                canvas.addNodeAt(r.left + r.width / 2 - 140, r.top + 80);
            }}>+ node</button>
            <button className="btn" title="write node types by hand" onClick={() => void openScriptPanel()}>scripts</button>
            <button className="btn" title="undo (ctrl/⌘+z)" onClick={undo}>↶</button>
            <button className="btn" title="redo (ctrl/⌘+shift+z)" onClick={redo}>↷</button>
            <button className="btn" title="frame every node (f)" onClick={() => canvas.fit()}>fit</button>
            <button className="btn" title="save the graph as JSON" onClick={exportGraph}>export</button>
            <button className="btn" title="load a graph from JSON" onClick={pickImport}>import</button>
            <button className="btn" title={options.resetTitle ?? 'start over (undo to go back)'} onClick={() => {
                reset();
                settle();
            }}>reset</button>
            <span className="graph-status">{status}</span>
        </nav>
    ) as HTMLElement;
    toolbar.append(...(options.toolbarEnd?.() ?? []));

    const trustBanner = (
        <div className="graph-banner" style={{ display: computed(() => (scriptsTrusted.get() ? 'none' : '')) }}>
            <span>This graph includes <b>script nodes</b>. They run as code in this page — review them first.</span>
            <button className="btn" onClick={() => void openScriptPanel()}>review</button>
            <button className="btn primary" onClick={trustScripts}>trust</button>
        </div>
    ) as HTMLElement;

    const suspendedBanner = (
        <div className="graph-banner" style={{ display: computed(() => (scriptsSuspended.get() ? '' : 'none')) }}>
            <span>The graph stopped responding and was restarted. <b>Script nodes are paused</b> — fix the stuck one, then resume.</span>
            <button className="btn" onClick={() => void openScriptPanel()}>scripts</button>
            <button className="btn primary" onClick={resumeScripts}>resume</button>
        </div>
    ) as HTMLElement;

    const el = (
        <div className="graph-app">
            {toolbar}
            {trustBanner}
            {suspendedBanner}
            {canvas.el}
            <div className="graph-help">
                <span className="legend ok">ok</span> <span className="legend error">error</span> <span className="legend slow">slow</span> <span className="legend skipped">skipped</span> · {options.help ?? DEFAULT_HELP}
            </div>
        </div>
    ) as HTMLElement;

    return {
        el,
        canvas,
        start() {
            boot();
            settle();
        },
        settle,
    };
}
