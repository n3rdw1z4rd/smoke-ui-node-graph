# smoke-ui-node-graph

A node graph editor for [smoke-ui](https://github.com/n3rdw1z4rd/smoke-ui), built on [`@n3rdw1z4rd/core/graph`](https://github.com/n3rdw1z4rd/core): nodes as DOM, wires as SVG, inline widgets, selection, groups, subgraphs, a code editor for every node, undo / redo, autosave, and evaluation in a Web Worker. It's the editor from [apparatus](https://github.com/n3rdw1z4rd/apparatus), pulled out so other projects can use it.

```
npm install @n3rdw1z4rd/smoke-ui-node-graph @n3rdw1z4rd/core @n3rdw1z4rd/smoke-ui
```

## Quick start

Two files: the page, and the worker that evaluates the graph.

```ts
// main.ts
import { configure, createGraphEditor } from '@n3rdw1z4rd/smoke-ui-node-graph';
import '@n3rdw1z4rd/smoke-ui-node-graph/style.css';
import { registerMyNodes } from './my-nodes';

configure({
    register: registerMyNodes,
    worker: () => new Worker(new URL('./eval.worker.ts', import.meta.url), { type: 'module' }),
    storageKey: 'my-app.graph',
});

const editor = createGraphEditor({ brand: { label: 'my app' } });
document.body.append(editor.el);
editor.start();   // loads the autosaved graph (or the initial one) and frames it
```

```ts
// eval.worker.ts
import { serveGraphEvaluation } from '@n3rdw1z4rd/smoke-ui-node-graph/worker';
import { registerMyNodes } from './my-nodes';

serveGraphEvaluation({ register: registerMyNodes });
```

Your nodes are registered twice, with the same function: in the page (for their pins and widgets) and in the worker (where they run). Script nodes, the ones written in the editor, only ever run in the worker, so one stuck in a loop can't freeze the page: after 3 s without an answer the worker is replaced and script nodes are paused.

## What you get

- **Canvas**: pan (drag empty space, scroll), zoom (pinch, ⌘ / ctrl + scroll), wire by dragging from a pin (drop on empty space to add a node there), box-select (shift + drag), copy / cut / paste / duplicate (across tabs too), delete, enable / disable (`m`), per-node animation (⟳), resize
- **Node states**: borders show ok / error / slow / skipped; errors stay local, and a node's footer previews its output
- **Selection**: the chain through the selection lights up both ways, nodes and wires
- **Groups** (⌘ / ctrl + g) and **subgraphs**: collapse a selection into a reusable node, go inside, edit (every instance follows), come back out, expand it again
- **Code**: ✎ on any node shows its source; save a built-in as a custom version, or write new node types (**scripts**). Graphs carry their own scripts, and an imported graph's scripts wait for you to trust them
- **Undo / redo**, **autosave** (localStorage), **import / export** as JSON

## Configuration

`configure(config)`, once, before anything else (one editor per page):

| Option | What it is |
| ------ | ---------- |
| `worker` | starts the evaluation worker: `() => new Worker(…, { type: 'module' })` |
| `register(registry)` | registers your node types (besides core's built-ins) |
| `initial(registry)` | the document to start with when nothing is saved, and what reset loads (default: empty) |
| `storageKey` | the localStorage key it autosaves under (`null`: no autosave) |
| `exportName` | the file name export saves as |

In the worker, `serveGraphEvaluation({ register, kinds })`. `kinds` are the [module kinds](https://github.com/n3rdw1z4rd/core#node-graphs-n3rdw1z4rdcoregraph) your script nodes may be besides `run` nodes (apparatus's behaviours are one).

`createGraphEditor(options)`:

| Option | What it is |
| ------ | ---------- |
| `brand` | `{ label, href?, title? }`: the name at the left of the toolbar |
| `toolbarEnd()` | your own toolbar items, at the right end |
| `plugins` | node body plugins (below) |
| `categoryColors` | header tints for your node categories (`{ physics: '#e8554e' }`) |
| `resetTitle`, `help` | the reset button's tooltip; the help bar's text |

It returns `{ el, canvas, start(), settle() }`. `settle()` tidies and frames a freshly loaded graph.

## Extending it

**Node body plugins** draw something under a node's pins: a live view, a chart. apparatus's Viewport (a running physics scene) is one:

```ts
const chart: NodeBodyPlugin = {
    types: ['output/chart'],
    body: (node) => chartFor(node.id),         // keep it per node id: it's re-mounted on rebuilds
    sized: (id) => chartFor(id),                // gets a resize grip; shown in a floating preview inside subgraphs
    defaultSize: [360, 240],
    refresh() { /* after every evaluation and selection change: read `results`, `selection`… */ },
    dispose(id) { /* the node is gone */ },
};
createGraphEditor({ plugins: [chart] });
```

Give elements that handle their own pointer and wheel input the `graph-interactive` class, and the editor leaves those events alone.

**Previews** for your own value types (node footers, pin tooltips): `addPreviewer((value, preview) => isMyThing(value) ? 'my thing' : undefined)`.

**State**: the editor's state is exported as smoke-ui signals and functions: `results`, `selection`, `status`, `runtimeErrors` (errors you report for nodes while running something), `picked` (`{ node, index }`: which item of a list node to name in its footer), `rootDoc()`, `edit(label, change)`, `undo()`, `openDocument(doc)`, `evaluateFrame(frame)` (per-frame evaluation of animated nodes), and more.

## Development

```
npm install
npm run build        # tsc → dist/, plus dist/style.css
npm run typecheck
```

---

*Part of a long-running collection of from-scratch graphics and simulation experiments.*
