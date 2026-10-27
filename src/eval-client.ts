import type { FrameInfo, GraphDoc, NodeResult } from '@n3rdw1z4rd/core/graph';
import type { FromEvalWorker, NodeInterface, ToEvalWorker } from './eval-protocol';

/** No reply for this long means the worker is stuck (probably a script node in a loop). */
export const EVAL_HANG_MS = 3000;

export interface EvalReply {
    order: string[];
    results: [string, NodeResult][];
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; since: number };

/** Main-thread handle to the evaluation worker (one that calls `serveGraphEvaluation`). */
export class GraphWorker {
    readonly ready: Promise<void>;
    private readonly worker: Worker;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private sentRev = -1;
    private disposed = false;

    constructor(start: () => Worker) {
        this.worker = start();
        let ready!: () => void;
        this.ready = new Promise((r) => (ready = r));
        this.worker.onmessage = (ev: MessageEvent<FromEvalWorker>) => {
            const msg = ev.data;
            if (msg.t === 'ready') return ready();
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.t === 'result') p.resolve({ order: msg.order, results: msg.results });
            else if (msg.t === 'compiled') msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.spec);
            else p.reject(new Error(msg.error));
        };
        this.worker.onerror = (ev) => {
            ev.preventDefault();
            this.failAll(new Error(ev.message || 'graph worker crashed'));
        };
    }

    /** True when a request has gone unanswered for longer than EVAL_HANG_MS. */
    get hung(): boolean {
        const now = performance.now();
        for (const p of this.pending.values()) if (now - p.since > EVAL_HANG_MS) return true;
        return false;
    }

    get busy(): boolean {
        return this.pending.size > 0;
    }

    /** Evaluates `doc` (sent only if `rev` changed since last time). */
    evaluate(doc: GraphDoc, rev: number, frame?: FrameInfo): Promise<EvalReply> {
        if (rev !== this.sentRev) {
            this.send({ t: 'doc', rev, doc });
            this.sentRev = rev;
        }
        return this.request((id) => ({ t: 'eval', id, frame }));
    }

    /** Compiles a script node type in the worker; resolves with its interface. */
    compile(type: string, source: string): Promise<NodeInterface> {
        return this.request((id) => ({ t: 'compile', id, type, source }));
    }

    dispose(reason = 'graph worker stopped'): void {
        this.disposed = true;
        this.worker.terminate();
        this.failAll(new Error(reason));
    }

    private request<T>(make: (id: number) => ToEvalWorker): Promise<T> {
        if (this.disposed) return Promise.reject(new Error('graph worker stopped'));
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, since: performance.now() });
            this.send(make(id));
        });
    }

    private send(msg: ToEvalWorker): void {
        if (!this.disposed) this.worker.postMessage(msg);
    }

    private failAll(err: Error): void {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }
}
