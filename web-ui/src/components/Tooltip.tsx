/**
 * bunri DAW — ツールチップ（マウスを載せた要素のそばに出す短い説明）
 *
 * 画面全体で 1 つだけ置く（`main.tsx`）。説明を出したい要素には `data-tip` を書くだけでよい
 * （`lib/tooltip.ts` の `tip()`）。React で描く部品にも、文字列で組み立てるタイムラインにも同じ書き方で付く。
 *
 * ブラウザ標準の `title` を使わない理由: 出るまで 1 秒ほど待たされる、出る位置を選べない、見た目を変えられない。
 *
 * 振る舞い:
 * - マウスを載せて少し（SHOW_DELAY_MS）待つと出る。出ているあいだ・消えた直後に隣の要素へ移ったときは、待たずに出す
 * - 押したら消す。そのまま同じ場所に居るあいだは出し直さない（押した後の画面を隠さない）
 * - Esc・その要素が動くスクロール・窓の外へ出たとき・要素が消えたときにも消す
 * - キーボードで要素を選んだとき（`:focus-visible`）にも出す
 * - ツールチップ自体はマウスの操作を受けない（`pointer-events: none`）。下の要素はそのまま押せる
 * - `<label>` に載せたときは、そのラベルが指す入力欄の説明を出す
 */
import { useEffect, useRef } from 'react';
import { placeTip, TIP_ATTR, type TipSide } from '../lib/tooltip';

/** マウスを載せてから出すまで。短くして「すぐ出る」ようにしつつ、画面を横切るだけで点滅しない長さ */
const SHOW_DELAY_MS = 150;
/** 消えてからこの時間のうちに別の要素へ移ったら、待たずに出す */
const WARM_MS = 400;
/** 置き場所に向きの指定が無いときの向き */
const DEFAULT_SIDE: TipSide = 'top';
const SIDES: TipSide[] = ['top', 'bottom', 'left', 'right'];

export const TOOLTIP_ID = 'bunri-tooltip';

interface Target {
    /** 説明を持つ要素 */
    source: HTMLElement;
    /** 位置を合わせる要素（ラベルに載せたときはラベル、それ以外は source） */
    rectEl: HTMLElement;
}

/** マウスの下の要素から、説明を出す相手を探す。 */
function resolve(start: Element | null): Target | null {
    if (!start || start.closest(`#${TOOLTIP_ID}`)) return null;
    const source = start.closest<HTMLElement>(`[${TIP_ATTR}]`);
    if (source) return usable(source) ? { source, rectEl: source } : null;
    // ラベルに載せたとき: ラベルが指す入力欄の説明
    const label = start.closest('label');
    const control = label?.control as HTMLElement | null | undefined;
    if (label && control?.hasAttribute(TIP_ATTR) && usable(control)) return { source: control, rectEl: label };
    return null;
}

/** 説明が空のとき、「切れているときだけ」の指定で切れていないときは出さない。 */
function usable(el: HTMLElement): boolean {
    if (!el.getAttribute(TIP_ATTR)) return false;
    if (el.hasAttribute('data-tip-overflow')) return el.scrollWidth > el.clientWidth + 1;
    return true;
}

function sideOf(el: HTMLElement): TipSide {
    const side = el.closest(`[data-tip-side]`)?.getAttribute('data-tip-side') as TipSide | null;
    return side && SIDES.includes(side) ? side : DEFAULT_SIDE;
}

function inside(r: DOMRect, x: number, y: number): boolean {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export default function TooltipLayer() {
    const tipRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const box = tipRef.current;
        if (!box) return;
        const textEl = box.querySelector<HTMLElement>('.tooltip-text')!;
        const keyEl = box.querySelector<HTMLElement>('.tooltip-key')!;

        let shown: Target | null = null;
        let shownBy: 'pointer' | 'focus' | null = null;
        let pending: Target | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let watch: ReturnType<typeof setInterval> | undefined;
        let lastHidden = 0;
        // 押した場所。マウスがここから出るまで出し直さない (押すと描き直される要素もあるので、要素ではなく場所で覚える)
        let pressedRect: DOMRect | null = null;
        let observer: MutationObserver | null = null;
        let prevDescribedBy: string | null = null;
        // 押した直後のフォーカスは、キーボードからではないので出さない (文字の欄は押しても :focus-visible になる)
        let lastPointerDown = -Infinity;

        const place = () => {
            if (!shown) return;
            const placement = placeTip(
                shown.rectEl.getBoundingClientRect(),
                { width: box.offsetWidth, height: box.offsetHeight },
                { width: window.innerWidth, height: window.innerHeight },
                sideOf(shown.source),
                shown.source.closest('[data-tip-box]')?.getBoundingClientRect(),
            );
            box.style.left = `${Math.round(placement.x)}px`;
            box.style.top = `${Math.round(placement.y)}px`;
            box.style.setProperty('--tip-arrow', `${Math.round(placement.arrow)}px`);
            box.dataset.side = placement.side;
        };

        const fill = (source: HTMLElement) => {
            textEl.textContent = source.getAttribute(TIP_ATTR) ?? '';
            const key = source.getAttribute('data-tip-key');
            keyEl.textContent = key ?? '';
            keyEl.hidden = !key;
        };

        const hide = () => {
            clearTimeout(timer);
            pending = null;
            if (!shown) return;
            clearInterval(watch);
            observer?.disconnect();
            observer = null;
            if (prevDescribedBy === null) shown.source.removeAttribute('aria-describedby');
            else shown.source.setAttribute('aria-describedby', prevDescribedBy);
            shown = null;
            shownBy = null;
            box.classList.remove('visible');
            box.hidden = true;
            lastHidden = performance.now();
        };

        const show = (target: Target, by: 'pointer' | 'focus') => {
            clearTimeout(timer);
            pending = null;
            if (shown && shown.source !== target.source) hide();
            if (!target.source.isConnected) return;
            shown = target;
            shownBy = by;
            fill(target.source);
            // 大きさを測ってから置く (見えない状態で一度描く)
            box.hidden = false;
            box.classList.remove('visible');
            box.style.left = '0px';
            box.style.top = '0px';
            place();
            box.classList.add('visible');
            // 読み上げでも、説明として読まれるようにする
            prevDescribedBy = target.source.getAttribute('aria-describedby');
            const ids = (prevDescribedBy ?? '').split(/\s+/).filter(Boolean);
            if (!ids.includes(TOOLTIP_ID)) target.source.setAttribute('aria-describedby', [...ids, TOOLTIP_ID].join(' '));
            // 出しているあいだに説明が変わったら (▶ が ⏸ になった、など)、書き換えて置き直す
            observer = new MutationObserver(() => {
                if (!shown) return;
                if (!usable(shown.source)) { hide(); return; }
                fill(shown.source);
                place();
            });
            observer.observe(target.source, { attributes: true, attributeFilter: [TIP_ATTR, 'data-tip-key'] });
            // 要素が消えたら (タイムラインの描き直し、パネルの切り替え) 消す
            watch = setInterval(() => {
                if (!shown?.source.isConnected || !shown.rectEl.isConnected) hide();
            }, 250);
        };

        const schedule = (target: Target | null) => {
            if (!target) { hide(); return; }
            if (shown?.source === target.source || pending?.source === target.source) return;
            const warm = shown !== null || performance.now() - lastHidden < WARM_MS;
            if (shown) hide();
            if (warm) { show(target, 'pointer'); return; }
            clearTimeout(timer);
            pending = target;
            timer = setTimeout(() => { if (pending) show(pending, 'pointer'); }, SHOW_DELAY_MS);
        };

        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
            // ドラッグ中 (ノートやクリップを動かしている、つまみを回している) は出さない
            if (e.buttons !== 0) { if (shownBy === 'pointer') hide(); return; }
            if (pressedRect) {
                if (inside(pressedRect, e.clientX, e.clientY)) return;
                pressedRect = null;
            }
            // 押せないボタン (disabled) の上では、イベントの相手が親になる環境があるので、位置から引き直す
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const target = resolve(under);
            if (!target && shownBy === 'focus') return;
            schedule(target);
        };

        const onPointerDown = (e: PointerEvent) => {
            lastPointerDown = performance.now();
            const target = shown ?? pending ?? resolve(e.target as Element);
            if (target) pressedRect = target.rectEl.getBoundingClientRect();
            hide();
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (!shown && !pending) return;
            if (e.key === 'Escape') {
                if (shown) pressedRect = shown.rectEl.getBoundingClientRect();
                hide();
                return;
            }
            // Tab で次へ移るときは、移った先 (focusin) で出し直す。それ以外のキーは、操作を始めたので消す
            if (e.key !== 'Tab' && e.key !== 'Shift') hide();
        };

        const onFocusIn = (e: FocusEvent) => {
            const el = e.target as HTMLElement;
            if (performance.now() - lastPointerDown < 300) return;
            let visible = false;
            try { visible = el.matches(':focus-visible'); } catch { /* 古い環境では、キーボードからでも出さない */ }
            if (!visible) return;
            const source = el.closest<HTMLElement>(`[${TIP_ATTR}]`);
            if (source && usable(source)) show({ source, rectEl: source }, 'focus');
        };

        const onFocusOut = () => { if (shownBy === 'focus') hide(); };
        const onLeaveWindow = (e: MouseEvent) => { if (!e.relatedTarget) hide(); };
        // 説明している要素が動くスクロールのときだけ消す (再生中に別の場所が自動でスクロールしても消さない)
        const onScroll = (e: Event) => {
            if (!shown) return;
            const scrolled = e.target;
            if (scrolled === document || (scrolled instanceof Node && scrolled.contains(shown.rectEl))) hide();
        };

        document.addEventListener('pointermove', onPointerMove, { passive: true });
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('focusin', onFocusIn);
        document.addEventListener('focusout', onFocusOut);
        document.addEventListener('mouseout', onLeaveWindow);
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('blur', hide);
        window.addEventListener('resize', hide);
        return () => {
            hide();
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('focusin', onFocusIn);
            document.removeEventListener('focusout', onFocusOut);
            document.removeEventListener('mouseout', onLeaveWindow);
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('blur', hide);
            window.removeEventListener('resize', hide);
        };
    }, []);

    return (
        <div id={TOOLTIP_ID} className="tooltip" role="tooltip" ref={tipRef} hidden>
            <span className="tooltip-text" />
            <kbd className="tooltip-key" hidden />
            <span className="tooltip-arrow" aria-hidden="true" />
        </div>
    );
}
