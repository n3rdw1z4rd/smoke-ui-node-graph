/**
 * A node graph editor for smoke-ui, on `@n3rdw1z4rd/core/graph`.
 *
 * ```ts
 * import { configure, createGraphEditor } from '@n3rdw1z4rd/smoke-ui-node-graph';
 * import '@n3rdw1z4rd/smoke-ui-node-graph/style.css';
 * import { registerMyNodes } from './my-nodes';
 *
 * configure({
 *     register: registerMyNodes,
 *     worker: () => new Worker(new URL('./eval.worker.ts', import.meta.url), { type: 'module' }),
 * });
 * const editor = createGraphEditor({ brand: { label: 'my app' } });
 * document.body.append(editor.el);
 * editor.start();
 * ```
 *
 * The worker (`eval.worker.ts`) evaluates the graph off the main thread:
 *
 * ```ts
 * import { serveGraphEvaluation } from '@n3rdw1z4rd/smoke-ui-node-graph/worker';
 * import { registerMyNodes } from './my-nodes';
 *
 * serveGraphEvaluation({ register: registerMyNodes });
 * ```
 *
 * @module
 */
export { createGraphEditor, DEFAULT_HELP, type GraphEditor, type GraphEditorOptions } from './editor';
export { GraphCanvas, DEFAULT_CATEGORY_COLORS, SLOW_MS, SLOW_ANIMATED_MS, type CanvasOptions, type NodeState } from './canvas';
export type { NodeBodyPlugin } from './plugins';
export {
    configure, registry, rootDoc, doc, editPath, enterSubgraph, exitSubgraph, edit, undo, redo, openDocument, replace, reset,
    adjustLayout, scheduleEvaluate, evaluateFrame, isAnimated, resumeScripts, compileScripts, saveScript, isScriptType,
    freeTypeName, forkNodes, boot, importGraph, exportGraph, trustScripts, docRevision, docEpoch, typesRevision, results,
    selection, status, runtimeErrors, picked, scriptsTrusted, scriptsSuspended, type EditorConfig,
} from './state';
export { openScriptPanel, closeScriptPanel } from './script-panel';
export { addPreviewer, preview, type Previewer } from './widgets';
export { chainOf } from './chain';
export { h, svg } from './dom';
export { wheelIntent, type WheelIntent } from './wheel';
export { EVAL_HANG_MS } from './eval-client';
export type { NodeInterface } from './eval-protocol';
