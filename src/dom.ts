/** A tiny DOM builder for the editor's hot paths (node views are rebuilt often). */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, any> = {},
    ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'className') el.className = v;
        else if (k === 'style' && typeof v === 'object') {
            // custom properties (--x) need setProperty: plain assignment ignores them
            for (const [p, val] of Object.entries(v)) {
                if (p.startsWith('--')) el.style.setProperty(p, String(val));
                else (el.style as any)[p] = val;
            }
        }
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in el && typeof v !== 'string') (el as any)[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
}

export const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
};
