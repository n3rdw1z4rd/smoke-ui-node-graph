import type { GraphDoc } from '@n3rdw1z4rd/core/graph';

/** Everything upstream and downstream of `ids` (and the wires on the way). */
export function chainOf(doc: GraphDoc, ids: Set<string>): { nodes: Set<string>; links: Set<string> } {
    const nodes = new Set(ids);
    const links = new Set<string>();
    const walk = (dir: 'up' | 'down') => {
        const seen = new Set(ids);
        const todo = [...ids];
        while (todo.length) {
            const n = todo.pop()!;
            for (const l of doc.links) {
                const [here, next] = dir === 'up' ? [l.to.node, l.from.node] : [l.from.node, l.to.node];
                if (here !== n) continue;
                links.add(l.id);
                if (seen.has(next)) continue;
                seen.add(next);
                nodes.add(next);
                todo.push(next);
            }
        }
    };
    walk('up');
    walk('down');
    return { nodes, links };
}
