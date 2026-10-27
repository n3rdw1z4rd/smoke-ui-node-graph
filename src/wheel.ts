/* ------------------------------------------------------------------ */
/* Wheel events:                                                        */
/*  - plain scroll (trackpad two-finger, or a mouse wheel) → pan        */
/*  - trackpad pinch (the browser sends it with ctrlKey) → zoom         */
/*  - ⌘ / ctrl + scroll → zoom (for a mouse)                            */
/* Left-drag on empty space pans too (three-finger drag counts).        */
/* ------------------------------------------------------------------ */

export type WheelIntent =
    | { kind: 'pan'; dx: number; dy: number }
    | { kind: 'zoom'; factor: number };

export function wheelIntent(e: WheelEvent): WheelIntent {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
        // A pinch sends small deltas; a ctrl / ⌘ wheel notch sends ~100.
        const k = Math.abs(dy) < 50 ? 0.01 : 0.0015;
        return { kind: 'zoom', factor: Math.exp(-dy * k) };
    }
    return { kind: 'pan', dx, dy };
}
