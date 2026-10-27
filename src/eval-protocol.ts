import type { FrameInfo, GraphDoc, NodeResult, NodeSpec } from '@n3rdw1z4rd/core/graph';

/* Messages between the editor (GraphWorker) and the evaluation worker (serveGraphEvaluation). */

/** A node type's interface — everything but `run` (which stays in the worker). */
export type NodeInterface = Omit<NodeSpec, 'run'>;

export type ToEvalWorker =
    /** the document changed (sent before an eval that needs it) */
    | { t: 'doc'; rev: number; doc: GraphDoc }
    | { t: 'eval'; id: number; frame?: FrameInfo }
    /** compile a script node type; the reply carries its interface */
    | { t: 'compile'; id: number; type: string; source: string };

export type FromEvalWorker =
    | { t: 'ready' }
    | {
        t: 'result';
        id: number;
        /** every node evaluated this time (upstream first): results for others can be dropped */
        order: string[];
        /** results that changed since the last reply (the rest are as before) */
        results: [string, NodeResult][];
    }
    | { t: 'compiled'; id: number; type: string; spec?: NodeInterface; error?: string }
    | { t: 'failed'; id: number; error: string };
