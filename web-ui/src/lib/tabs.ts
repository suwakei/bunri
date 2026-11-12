/**
 * bunri DAW — タブの段（components/SubTabs.tsx）の id と、中身の枠の属性。
 */

/** タブ 1 つぶん。 */
export interface TabDef<K extends string> {
    key: K;
    label: string;
}

/** タブの id。 */
export function tabId(prefix: string, key: string): string {
    return prefix ? `tab-${prefix}-${key}` : `tab-${key}`;
}

/** 中身の枠の id。 */
export function panelId(prefix: string, key: string): string {
    return prefix ? `tabpanel-${prefix}-${key}` : `tabpanel-${key}`;
}

/** 中身の枠に付ける属性。開いていないタブの中身は `hidden` で隠す（DOM には残す。入力の途中を失わない）。 */
export function tabPanelProps(prefix: string, key: string, active: string, className = 'panel-scroll') {
    return {
        id: panelId(prefix, key),
        className,
        role: 'tabpanel',
        'aria-labelledby': tabId(prefix, key),
        hidden: active !== key,
    } as const;
}
