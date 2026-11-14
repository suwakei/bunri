/**
 * bunri DAW — タブの段（左パネルの上の段と、「学ぶ」「音作り」の中の段で共通）。
 *
 * `role="tablist"` / `tab` で組み、左右の矢印キーと Home / End で移れる。
 * Tab キーで止まるのは、開いているタブだけ（矢印キーで移るため）。
 * 中身の枠（`role="tabpanel"`）は呼ぶ側が置き、`tabPanelProps` で属性を付ける。
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { panelId, tabId, type TabDef } from '../lib/tabs';
import { tip } from '../lib/tooltip';

/**
 * タブの段。
 *
 * @param idPrefix - タブと中身の枠の id の頭（`tab-<prefix>-<key>` / `tabpanel-<prefix>-<key>`。空なら `tab-<key>`）
 * @param label - タブの段の名前（読み上げ用）
 * @param tabs - タブの並び
 * @param active - 開いているタブ
 * @param onSelect - タブを選んだとき
 * @param id - 段の要素の id
 * @param className - 段の要素の class
 */
export default function SubTabs<K extends string>({ idPrefix, label, tabs, active, onSelect, id, className }: {
    idPrefix: string; label: string; tabs: TabDef<K>[]; active: K; onSelect: (key: K) => void;
    id?: string; className?: string;
}) {
    const refs = useRef<Record<string, HTMLButtonElement | null>>({});
    const handleKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const index = tabs.findIndex(tab => tab.key === active);
        let next = -1;
        if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        // 中の段のキー操作が、外の段に伝わらないようにする
        e.stopPropagation();
        onSelect(tabs[next].key);
        refs.current[tabs[next].key]?.focus();
    }, [tabs, active, onSelect]);

    return (
        // タブの説明は下に出す (横に出すと、隣のタブに重なる)
        <div id={id} className={className} role="tablist" aria-label={label} onKeyDown={handleKey} data-tip-side="bottom">
            {tabs.map(tab => (
                <button key={tab.key} type="button" role="tab"
                    id={tabId(idPrefix, tab.key)}
                    ref={el => { refs.current[tab.key] = el; }}
                    aria-selected={active === tab.key}
                    aria-controls={panelId(idPrefix, tab.key)}
                    tabIndex={active === tab.key ? 0 : -1}
                    className={active === tab.key ? 'active' : ''}
                    {...(tab.tip ? tip(tab.tip) : {})}
                    onClick={() => onSelect(tab.key)}>
                    {tab.label}
                </button>
            ))}
        </div>
    );
}
