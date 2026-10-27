import { portTypes, type NodeDef } from '@n3rdw1z4rd/core/graph';
import { h } from './dom';
import { registry } from './state';

/* ------------------------------------------------------------------ */
/* The add-node menu: type to search, arrows + enter or click to pick.  */
/* When opened from a dangling wire, only nodes that can take it show.  */
/* ------------------------------------------------------------------ */

let open: HTMLElement | null = null;

export function closeNodeMenu(): void {
    open?.remove();
    open = null;
}

export function openNodeMenu(container: HTMLElement, cx: number, cy: number, pick: (def: NodeDef) => void, opts: { fromType?: string; exclude?: (def: NodeDef) => boolean } = {}): void {
    closeNodeMenu();
    const all = registry.all()
        .filter((d) => !opts.exclude?.(d))
        .filter((d) => !opts.fromType || d.inputs.some((p) => portTypes.canConnect(opts.fromType!, p.type)))
        .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));

    const search = h('input', { className: 'node-menu-search', type: 'search', placeholder: opts.fromType ? `nodes that take ${opts.fromType}…` : 'add a node…' });
    const list = h('div', { className: 'node-menu-list' });
    const menu = h('div', { className: 'node-menu' }, search, list);
    let active = 0;
    let shown: NodeDef[] = [];

    const choose = (def: NodeDef | undefined) => {
        if (!def) return;
        closeNodeMenu();
        pick(def);
    };

    const draw = () => {
        const q = search.value.trim().toLowerCase();
        shown = all.filter((d) => !q || `${d.title} ${d.type} ${d.category} ${d.description}`.toLowerCase().includes(q));
        active = Math.min(active, Math.max(0, shown.length - 1));
        let cat = '';
        list.replaceChildren(...shown.flatMap((d, i) => {
            const items: HTMLElement[] = [];
            if (d.category !== cat) {
                cat = d.category;
                items.push(h('div', { className: 'node-menu-cat' }, cat));
            }
            const item = h('button', { className: i === active ? 'node-menu-item active' : 'node-menu-item', title: d.description || d.type },
                h('span', {}, d.title), h('span', { className: 'node-menu-type' }, d.type));
            item.addEventListener('click', () => choose(d));
            items.push(item);
            return items;
        }));
        if (!shown.length) list.append(h('div', { className: 'node-menu-cat' }, 'nothing matches'));
        list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };

    search.addEventListener('input', () => {
        active = 0;
        draw();
    });
    search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
        else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
        else if (e.key === 'Enter') return choose(shown[active]);
        else if (e.key === 'Escape') return closeNodeMenu();
        else return;
        e.preventDefault();
        draw();
    });

    const r = container.getBoundingClientRect();
    menu.style.left = `${Math.min(cx - r.left, r.width - 280)}px`;
    menu.style.top = `${Math.min(cy - r.top, r.height - 360)}px`;
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    container.append(menu);
    open = menu;
    draw();
    search.focus();

    // a press anywhere else closes it
    setTimeout(() => window.addEventListener('pointerdown', function away(e) {
        if (!open || open.contains(e.target as Node)) return;
        closeNodeMenu();
        window.removeEventListener('pointerdown', away);
    }), 0);
}
