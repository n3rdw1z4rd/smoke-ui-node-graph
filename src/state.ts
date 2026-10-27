import { Signal } from '@n3rdw1z4rd/smoke-ui';
import {
    GraphEvaluator, createGraph, createNodeRegistry, normalizeGraph, registerSubgraphs, type FrameInfo, type GraphDoc,
    type NodeRegistry, type NodeResult,
} from '@n3rdw1z4rd/core/graph';
import { EVAL_HANG_MS, GraphWorker } from './eval-client';
import type { NodeInterface } from './eval-protocol';

/* ------------------------------------------------------------------ */
/* Editor state. The graph document is a plain object, mutated in       */
/* place through `edit()` (which records undo history, autosaves and    */
/* schedules evaluation); `docRevision` tells the views it changed.     */
/* One editor per page: call `configure()` once, before anything else.  */
/* ------------------------------------------------------------------ */

export interface EditorConfig {
    /** registers your node types besides the built-ins (do the same in the worker: serveGraphEvaluation) */
    register?: (registry: NodeRegistry) => void;
    /** starts the evaluation worker: a module worker that calls `serveGraphEvaluation` */
    worker: () => Worker;
    /** the document to start with when nothing is saved, and what "reset" loads (default: an empty graph) */
    initial?: (registry: NodeRegistry) => GraphDoc;
    /** the localStorage key the graph autosaves under (null: no autosave). Default 'smoke-ui-node-graph' */
    storageKey?: string | null;
    /** the file name "export" saves as. Default 'graph.json' */
    exportName?: string;
}

let config: Required<Omit<EditorConfig, 'register'>> & Pick<EditorConfig, 'register'> | null = null;

/**
 * The editor's registry mirrors the worker's: built-ins and your registered nodes are the same
 * code; script node types are interfaces only (pins and widgets) — their code runs in the worker.
 */
export const registry = createNodeRegistry();

/** Sets the editor up: your node types, the evaluation worker, the starting document, autosave. */
export function configure(c: EditorConfig): void {
    if (config) throw new Error('the node graph editor is already configured (one per page)');
    config = { initial: () => createGraph(), storageKey: 'smoke-ui-node-graph', exportName: 'graph.json', ...c };
    config.register?.(registry);
    worker = new GraphWorker(config.worker);
    startWatchdog();
}

function configured(): NonNullable<typeof config> {
    if (!config) throw new Error('call configure() before using the node graph editor');
    return config;
}

/** used here only for `animated()` (which reads interfaces); evaluation happens in the worker */
const interfaces = new GraphEvaluator(registry);

/** The whole document: what's evaluated, saved and undone. */
let root: GraphDoc = createGraph();
export const rootDoc = (): GraphDoc => root;

/**
 * The graph being edited: the document itself, or — inside a subgraph — that subgraph's
 * inner graph (its definition object, edited in place). `editPath` is the way in.
 */
export let doc: GraphDoc = root;
export const editPath = new Signal<string[]>([]);

/** The graph at the end of `path` (null if a subgraph on the way is gone). */
function resolve(path: string[]): GraphDoc | null {
    let d: GraphDoc = root;
    for (const type of path) {
        const def = root.subgraphs?.[type];
        if (!def) return null;
        d = def as unknown as GraphDoc;
    }
    return d;
}

/** Goes into a subgraph type (from the current level). */
export function enterSubgraph(type: string): void {
    if (!root.subgraphs?.[type] || editPath.get().includes(type)) return;
    const path = [...editPath.get(), type];
    doc = resolve(path)!;
    selection.set(new Set());
    editPath.set(path);
    bump(docEpoch);
}

/** Goes back out to `depth` (0: the top level). */
export function exitSubgraph(depth = editPath.get().length - 1): void {
    const path = editPath.get().slice(0, Math.max(0, depth));
    doc = resolve(path) ?? root;
    selection.set(new Set());
    editPath.set(resolve(path) ? path : []);
    bump(typesRevision); // the subgraph's node(s) out here may have new pins
    bump(docEpoch);
}

/** Node types and subgraph definitions always live at the top level. */
function hoist(): void {
    if (doc === root) return;
    const inner = doc as Partial<GraphDoc>;
    if (inner.scripts) {
        root.scripts = { ...(root.scripts ?? {}), ...inner.scripts };
        delete inner.scripts;
    }
    if (inner.subgraphs) {
        root.subgraphs = { ...(root.subgraphs ?? {}), ...inner.subgraphs };
        delete inner.subgraphs;
    }
}

/** bumped on every change to the document (structure, values, positions) */
export const docRevision = new Signal(0);
/** bumped when the whole document is swapped (load, undo): views rebuild everything */
export const docEpoch = new Signal(0);
/** bumped when node types change (a script recompiled) */
export const typesRevision = new Signal(0);
/** the last evaluation's results */
export const results = new Signal<Map<string, NodeResult>>(new Map());
export const selection = new Signal<Set<string>>(new Set());
export const status = new Signal('');
/** errors a host reports for nodes while it runs the graph's output (e.g. while playing), by node id */
export const runtimeErrors = new Signal<Map<string, string>>(new Map());
/** an item of a list node picked elsewhere (e.g. clicked in a view): its footer says which */
export const picked = new Signal<{ node: string; index: number } | null>(null);
/** scripts in a loaded graph wait for this before they compile */
export const scriptsTrusted = new Signal(true);
/** set when the worker was replaced because it stopped responding: scripts wait for `resumeScripts()` */
export const scriptsSuspended = new Signal(false);

const bump = (s: Signal<number>) => s.set(s.get() + 1);

/* ── history ─────────────────────────────────────────────────────── */

const undoStack: string[] = [];
const redoStack: string[] = [];
let lastLabel = '';
let lastAt = 0;

/** Continuous edits (a drag, scrubbing a field, a resize) merge into one undo step. */
const MERGING = /^(move|value:|resize:)/;

/**
 * Changes the document. Consecutive continuous edits with the same `label` within a second
 * merge into one undo step; every other edit (connect, delete, toggle…) is its own step.
 */
export function edit(label: string, change: (doc: GraphDoc) => void): void {
    const now = performance.now();
    if (!MERGING.test(label) || label !== lastLabel || now - lastAt > 1000) {
        undoStack.push(JSON.stringify(root));
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
    }
    lastLabel = label;
    lastAt = now;
    change(doc);
    hoist();
    // edits inside a subgraph change its type: every instance follows
    registerSubgraphs(root, registry);
    changed();
}

export function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    status.set('');
    redoStack.push(JSON.stringify(root));
    replace(JSON.parse(prev), false, true);
}

export function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    status.set('');
    undoStack.push(JSON.stringify(root));
    replace(JSON.parse(next), false, true);
}

/**
 * Opens another document as one undoable step (examples, reset): undo goes back to what
 * you had.
 */
export function openDocument(next: GraphDoc, trusted: boolean): void {
    undoStack.push(JSON.stringify(root));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    scriptsTrusted.set(trusted || !Object.keys(next.scripts ?? {}).length);
    replace(next, false);
}

/** Starts over from the configured initial document, as one undoable step. */
export function reset(): void {
    openDocument(configured().initial(registry), true);
}

/** Swaps in another document (load, import, undo). `keepPath` stays inside the same subgraph if it still exists. */
export function replace(next: GraphDoc, resetHistory = true, keepPath = false): void {
    root = normalizeGraph(next);
    registerSubgraphs(root, registry);
    const path = keepPath && resolve(editPath.get()) ? editPath.get() : [];
    doc = resolve(path) ?? root;
    if (path.length !== editPath.get().length) editPath.set(path);
    if (resetHistory) {
        undoStack.length = 0;
        redoStack.length = 0;
    }
    lastLabel = '';
    const ids = new Set(doc.nodes.map((n) => n.id));
    selection.set(new Set([...selection.get()].filter((id) => ids.has(id))));
    void compileScripts();
    bump(docEpoch);
    changed();
}

/** Node positions were tidied (not an edit of yours): redraw and save, no undo step. */
export function adjustLayout(): void {
    bump(docRevision);
    scheduleSave();
}

function changed(): void {
    bump(docRevision);
    scheduleEvaluate();
    scheduleSave();
}

/* ── evaluation (in a worker) ────────────────────────────────────── */

let worker: GraphWorker = null as unknown as GraphWorker; // set by configure()
/** script sources the current worker has compiled */
let workerScripts = new Map<string, string>();

let queued = false;
let running = false;
let again = false;
let frame: FrameInfo | undefined;

/** Evaluates on the next microtask (edits in the same tick coalesce). */
export function scheduleEvaluate(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        void evaluate();
    });
}

/**
 * Evaluates for an animation frame (a host calls this per frame, e.g. while playing). Frames that
 * arrive while the worker is busy are folded into the next evaluation, not queued.
 */
export function evaluateFrame(f: FrameInfo): Promise<void> {
    frame = f;
    return evaluate();
}

/** Whether any output depends on an animated node. */
export function isAnimated(): boolean {
    return interfaces.animated(root).length > 0;
}

async function evaluate(): Promise<void> {
    if (running) {
        again = true; // run once more when the current one is back
        return;
    }
    running = true;
    try {
        await worker.ready;
        const reply = await worker.evaluate(root, docRevision.get(), frame);
        const keep = new Set(reply.order);
        const next = new Map<string, NodeResult>();
        for (const [id, r] of results.get()) if (keep.has(id)) next.set(id, r);
        for (const [id, r] of reply.results) next.set(id, r);
        results.set(next);
    } catch (err) {
        // a request cut off by a restart: the watchdog already said what happened
        if ((err as Error).message !== 'restarted') status.set(`evaluation failed: ${(err as Error).message}`);
    } finally {
        running = false;
        if (again) {
            again = false;
            scheduleEvaluate();
        }
    }
}

/* ── watchdog ────────────────────────────────────────────────────── */

function startWatchdog(): void {
    setInterval(() => {
        if (!worker.hung) return;
        worker.dispose('restarted');
        worker = new GraphWorker(configured().worker);
        workerScripts = new Map();
        scriptsSuspended.set(true);
        status.set(`the graph stopped responding for ${EVAL_HANG_MS / 1000}s (a script node stuck in a loop?) — restarted with script nodes paused`);
        scheduleEvaluate();
    }, 500);
}

/** Lets script nodes run again after a restart. */
export function resumeScripts(): void {
    scriptsSuspended.set(false);
    status.set('');
    void compileScripts();
}

/* ── script node types ───────────────────────────────────────────── */

/** Registers a script type's interface in the editor's registry (its code lives in the worker). */
function registerInterface(spec: NodeInterface): void {
    registry.register({ ...spec, run: () => { throw new Error('script nodes run in the graph worker'); } });
}

/** Compiles the document's script node types in the worker (once trusted and not suspended). */
export async function compileScripts(): Promise<void> {
    if (!scriptsTrusted.get() || scriptsSuspended.get()) return;
    const w = worker;
    for (const [type, source] of Object.entries(root.scripts ?? {})) {
        if (workerScripts.get(type) === source && registry.get(type)?.source === source) continue;
        try {
            registerInterface(await w.compile(type, source));
            workerScripts.set(type, source);
        } catch (err) {
            if (w === worker) status.set(`script node ${type}: ${(err as Error).message}`);
        }
    }
    bump(typesRevision);
    scheduleEvaluate();
}

/**
 * Saves (and compiles) a script node type; throws on a compile error, leaving the old one.
 * While scripts are paused it only saves the source ('saved'); resuming compiles it.
 */
export async function saveScript(type: string, source: string): Promise<'compiled' | 'saved'> {
    if (scriptsSuspended.get()) {
        edit(`script:${type}`, () => {
            root.scripts = { ...(root.scripts ?? {}), [type]: source };
        });
        return 'saved';
    }
    const spec = await worker.compile(type, source);
    workerScripts.set(type, source);
    registerInterface(spec);
    edit(`script:${type}`, (d) => {
        void d;
        root.scripts = { ...(root.scripts ?? {}), [type]: source };
    });
    bump(typesRevision);
    return 'compiled';
}

/** Whether a type is one of this graph's script node types (vs a built-in). */
export function isScriptType(type: string): boolean {
    return !!root.scripts?.[type];
}

/** A free type name based on `base` (`custom/box`, `custom/box-2`, …). */
export function freeTypeName(base: string): string {
    let name = base;
    for (let k = 2; registry.get(name) || root.scripts?.[name]; k++) name = `${base}-${k}`;
    return name;
}

/**
 * Saves `source` as a new script node type and switches the given nodes to it, keeping their
 * values and the wires whose ports still exist — one undo step. Throws on a compile error.
 */
export async function forkNodes(nodeIds: string[], type: string, source: string): Promise<void> {
    if (scriptsSuspended.get()) throw new Error('script nodes are paused — resume them first');
    if (registry.get(type) && !isScriptType(type)) throw new Error(`${type} is a built-in type — pick another name`);
    const spec = await worker.compile(type, source);
    workerScripts.set(type, source);
    registerInterface(spec);
    const def = registry.get(type)!;
    const ins = new Set(def.inputs.map((p) => p.name));
    const outs = new Set(def.outputs.map((p) => p.name));
    const ids = new Set(nodeIds);
    edit(`fork:${type}`, (d) => {
        root.scripts = { ...(root.scripts ?? {}), [type]: source };
        for (const n of d.nodes) if (ids.has(n.id)) n.type = type;
        d.links = d.links.filter((l) => !(ids.has(l.to.node) && !ins.has(l.to.port)) && !(ids.has(l.from.node) && !outs.has(l.from.port)));
    });
    bump(typesRevision);
}

/* ── autosave ────────────────────────────────────────────────────── */

let saveTimer = 0;

function scheduleSave(): void {
    const key = configured().storageKey;
    if (!key) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        try {
            localStorage.setItem(key, JSON.stringify(root));
        } catch { /* storage unavailable: nothing to do */ }
    }, 400);
}

/** Loads the autosaved graph (your own, so its scripts are trusted), or the initial document. */
export function boot(): void {
    const { storageKey, initial } = configured();
    try {
        const saved = storageKey && localStorage.getItem(storageKey);
        if (saved) {
            replace(JSON.parse(saved));
            return;
        }
    } catch { /* fall through to the initial document */ }
    replace(initial(registry));
}

/** Loads a graph from a file; its scripts wait for trust. */
export async function importGraph(file: File): Promise<void> {
    const parsed = normalizeGraph(JSON.parse(await file.text()));
    scriptsTrusted.set(!Object.keys(parsed.scripts ?? {}).length);
    replace(parsed);
}

export function exportGraph(): void {
    const blob = new Blob([JSON.stringify(root, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = configured().exportName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function trustScripts(): void {
    scriptsTrusted.set(true);
    void compileScripts();
}
