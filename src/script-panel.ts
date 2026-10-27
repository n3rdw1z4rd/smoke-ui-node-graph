import { SCRIPT_NODE_TEMPLATE, getNode } from '@n3rdw1z4rd/core/graph';
import { h } from './dom';
import {
    doc, forkNodes, freeTypeName, isScriptType, registry, resumeScripts, saveScript, scriptsSuspended, scriptsTrusted,
    selection, trustScripts,
} from './state';

/* ------------------------------------------------------------------ */
/* The code panel. A node is a function: ✎ on any node shows its code. */
/*                                                                      */
/*  - a script node type: edit it in place (every node of the type     */
/*    follows), or "save as" a new type for this node                  */
/*  - a built-in: read-only original; "save as custom" creates a        */
/*    script type from it (e.g. custom/box) and switches this node —   */
/*    or every node of that type — to it                                */
/*                                                                      */
/* Script types are saved in the graph document, so a graph file       */
/* carries its own node types.                                          */
/* ------------------------------------------------------------------ */

type View = import('codemirror').EditorView;

let panel: HTMLElement | null = null;
let view: View | null = null;
let onAdd: (type: string) => void = () => {};

/** Called with a type when the panel's "add to graph" is pressed. */
export function setScriptAddHandler(fn: (type: string) => void): void {
    onAdd = fn;
}

export function closeScriptPanel(): void {
    panel?.remove();
    panel = null;
    view?.destroy();
    view = null;
}

/** Marks a source as a custom version: "Box" → "Box (custom)". */
function customTitle(source: string, title: string): string {
    const custom = `${title.replace(/ \(custom\)$/, '')} (custom)`;
    const re = /export\s+const\s+title\s*=\s*(['"`])(?:\\.|(?!\1).)*\1\s*;?/;
    return re.test(source) ? source.replace(re, `export const title = ${JSON.stringify(custom)};`) : `export const title = ${JSON.stringify(custom)};\n${source}`;
}

/**
 * Opens the panel: on a type (and the node it was opened from), or on the graph's first
 * script type, or empty to start a new one.
 */
export async function openScriptPanel(opts: { type?: string; nodeId?: string } = {}): Promise<void> {
    closeScriptPanel();
    const scripts = () => Object.keys(doc.scripts ?? {});
    let current = opts.type ?? scripts()[0] ?? '';
    const nodeId = opts.nodeId;

    const status = h('div', { className: 'sp-status' });
    const host = h('div', { className: 'sp-editor' }, 'loading editor…');
    const picker = h('select', { className: 'gw-select sp-picker', title: 'script node types in this graph' });
    const heading = h('div', { className: 'sp-heading' });
    const forkRow = h('div', { className: 'sp-bar' });
    const editRow = h('div', { className: 'sp-bar' });
    const nameInput = h('input', { className: 'gw-text', type: 'text', placeholder: 'type name, e.g. custom/box' });
    const allBox = h('input', { type: 'checkbox', className: 'gw-check' });
    const allLabel = h('label', { className: 'sp-check' }, allBox, h('span', {}));

    const say = (text: string, tone: '' | 'ok' | 'err' = '') => {
        status.className = `sp-status ${tone}`;
        status.textContent = text;
    };
    const source = () => view?.state.doc.toString() ?? '';
    const setSource = (s: string) => view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } });
    const sameType = (type: string) => doc.nodes.filter((n) => n.type === type).map((n) => n.id);

    /** Lays the panel out for the current type. */
    const show = () => {
        const def = current ? registry.get(current) : undefined;
        const script = !!current && isScriptType(current);
        const builtin = !!def && !script;
        const title = def?.title ?? current;
        const node = nodeId ? getNode(doc, nodeId) : undefined;
        const others = def ? sameType(def.type).length : 0;

        picker.replaceChildren(...scripts().map((t) => h('option', { value: t }, t)));
        picker.value = script ? current : '';
        picker.disabled = !scripts().length;

        heading.replaceChildren(
            builtin ? h('span', {}, h('b', {}, title), ' is built in — its code is shown below. Change it and save a ', h('b', {}, 'custom version'), '; the original stays as it is.')
                : script ? h('span', {}, 'Script node ', h('b', {}, current), others > 1 ? ` · ${others} nodes use it` : '')
                    : h('span', {}, 'Name a new node type to start.'),
        );

        // "save as": a new type for this node (or every node of this type)
        forkRow.hidden = !def;
        if (def) {
            nameInput.value = freeTypeName(builtin ? `custom/${def.type.split('/').pop()}` : `${def.type}-copy`);
            (allLabel.lastChild as HTMLElement).textContent = ` every ${title} node (${others})`;
            allBox.checked = false;
            allLabel.hidden = !node || others < 2;
            forkRow.replaceChildren(
                nameInput,
                allLabel,
                h('button', { className: builtin ? 'btn primary' : 'btn', title: 'save as a new type and switch this node to it', onclick: () => void saveAs() },
                    builtin ? 'save as custom' : 'save as new type'),
            );
        }

        // edit in place (script types only)
        editRow.hidden = !script;
        if (script) {
            editRow.replaceChildren(
                h('button', { className: 'btn primary', title: `save and compile (ctrl/⌘+s)${others > 1 ? ` — all ${others} nodes follow` : ''}`, onclick: () => void save() }, 'save'),
                h('button', { className: 'btn', title: 'add a node of this type to the graph', onclick: () => onAdd(current) }, '+ to graph'),
            );
        }
    };

    const load = (type: string) => {
        current = type;
        const def = registry.get(type);
        const builtin = !!def && !isScriptType(type);
        const code = doc.scripts?.[type] ?? def?.source ?? SCRIPT_NODE_TEMPLATE;
        setSource(builtin ? customTitle(code, def!.title) : code);
        show();
        say(builtin ? `${type} · built in` : type ? `${type}${registry.get(type) ? '' : ' · not compiled yet'}` : '');
    };

    /** Saves a script type in place. */
    const save = async () => {
        if (!current || !isScriptType(current)) return;
        try {
            const how = await saveScript(current, source());
            say(how === 'compiled' ? `saved · ${current} compiled` : `saved · ${current} (script nodes are paused: resume to run it)`, 'ok');
            show();
        } catch (err) {
            say((err as Error).message, 'err');
        }
    };

    /** Saves as a new type and switches the node(s) to it. */
    const saveAs = async () => {
        const raw = nameInput.value.trim().replace(/\s+/g, '-');
        if (!raw) return nameInput.focus();
        const type = raw.includes('/') ? raw : `custom/${raw}`;
        const from = current;
        const targets = nodeId && getNode(doc, nodeId)
            ? (allBox.checked ? sameType(from) : [nodeId])
            : [];
        try {
            if (targets.length) {
                await forkNodes(targets, type, source());
                selection.set(new Set(targets));
            } else {
                await saveScript(type, source());
            }
            current = type;
            show();
            say(targets.length ? `saved ${type} · ${targets.length} node${targets.length === 1 ? '' : 's'} now use${targets.length === 1 ? 's' : ''} it` : `saved ${type}`, 'ok');
        } catch (err) {
            say((err as Error).message, 'err');
        }
    };

    /** Starts a brand-new script type from the template. */
    const newType = () => {
        current = '';
        setSource(SCRIPT_NODE_TEMPLATE);
        show();
        forkRow.hidden = false;
        nameInput.value = freeTypeName('custom/node');
        forkRow.replaceChildren(nameInput, h('button', { className: 'btn primary', onclick: () => void saveAs() }, 'create'));
        nameInput.focus();
        nameInput.select();
        say('name it and press create');
    };

    picker.addEventListener('change', () => load(picker.value));
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && void saveAs());

    panel = h('aside', { className: 'script-panel' },
        h('div', { className: 'sp-bar' },
            h('b', {}, 'node code'),
            picker,
            h('button', { className: 'btn', title: 'start a new node type from a template', onclick: newType }, 'new'),
            h('button', { className: 'btn', title: 'close (esc)', onclick: closeScriptPanel }, '✕')),
        heading,
        scriptsSuspended.get()
            ? h('div', { className: 'sp-status err' }, 'Script nodes are paused after the graph stopped responding. Fix the stuck script and save, then ',
                h('button', { className: 'btn', onclick: () => { resumeScripts(); closeScriptPanel(); } }, 'resume'))
            : null,
        !scriptsTrusted.get()
            ? h('div', { className: 'sp-status err' }, 'This graph came from a file: its scripts are not running. ',
                h('button', { className: 'btn', onclick: () => { trustScripts(); closeScriptPanel(); } }, 'trust and run them'))
            : null,
        host,
        forkRow,
        editRow,
        status);
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeScriptPanel();
    });
    (document.querySelector('.graph-app') ?? document.body).append(panel);

    const [{ EditorView, basicSetup }, { javascript }, { oneDark }, { keymap }] = await Promise.all([
        import('codemirror'),
        import('@codemirror/lang-javascript'),
        import('@codemirror/theme-one-dark'),
        import('@codemirror/view'),
    ]);
    if (!panel) return; // closed while loading
    host.textContent = '';
    view = new EditorView({
        parent: host,
        doc: '',
        extensions: [
            keymap.of([{ key: 'Mod-s', run: () => { void (isScriptType(current) ? save() : saveAs()); return true; } }]),
            basicSetup,
            javascript(),
            oneDark,
            EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } }),
        ],
    });
    if (current) load(current);
    else newType();
    view.focus();
}
