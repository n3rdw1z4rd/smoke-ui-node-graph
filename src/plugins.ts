import type { GraphNode, NodeDef } from '@n3rdw1z4rd/core/graph';

/**
 * Draws a custom body for some node types, under their pins and widgets: a live view, a chart,
 * a preview. apparatus's Viewport node is one.
 *
 * Elements inside a body that handle their own pointer and wheel input (a canvas you can drag
 * in) get the `graph-interactive` class, so the editor leaves those events alone.
 */
export interface NodeBodyPlugin {
    /** the node types it draws a body for */
    types: readonly string[];
    /**
     * The body for a node. Called whenever the node's view is rebuilt; keep whatever should
     * survive that (and the `sized` element) per node id, and put it back into a new body.
     */
    body(node: GraphNode, def: NodeDef): HTMLElement;
    /**
     * The element a resize sets the height of. Nodes of these types get a resize grip; while
     * you're inside a subgraph, top-level ones keep showing it in a floating preview.
     */
    sized?(nodeId: string): HTMLElement | undefined;
    /** the size a newly added node starts with: [width, height] */
    defaultSize?: [number, number];
    /** hide the ✎ (view code) button on these nodes */
    hideCode?: boolean;
    /** the node is gone from the document for good: free what `body` made */
    dispose?(nodeId: string): void;
    /** called after every evaluation and selection change: read `results`, `selection`… from the editor state */
    refresh?(): void;
}
