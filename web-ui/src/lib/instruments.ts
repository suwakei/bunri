/** 楽器の一覧と、必要な素材の状態。カタログの正本は処理を担当する部分が持つ。 */
import { apiFetch, errorDetail } from './api';

export const DEFAULT_INSTRUMENT_ID = 'salamander';

export interface InstrumentStatus {
    id: string;
    name: string;
    category: string;
    kind: 'sampler';
    packId: string;
    installed: boolean;
    downloadBytes: number;
    author: string;
    license: string;
    sourceUrl: string;
    description?: string;
}

export async function fetchInstruments(): Promise<InstrumentStatus[]> {
    const response = await apiFetch('/api/instruments');
    if (!response.ok) throw new Error(await errorDetail(response));
    return (await response.json() as { instruments: InstrumentStatus[] }).instruments;
}

/** 同じ素材を使う音色は、ダウンロード後にまとめて用意できた状態にする。 */
export function markPackInstalled(catalog: InstrumentStatus[], installed: InstrumentStatus): InstrumentStatus[] {
    return catalog.map((item) => item.packId === installed.packId ? { ...item, installed: true } : item);
}

export function instrumentGroups(catalog: InstrumentStatus[], query: string, selectedId: string): Map<string, InstrumentStatus[]> {
    const key = query.trim().toLocaleLowerCase();
    const groups = new Map<string, InstrumentStatus[]>();
    for (const item of catalog) {
        if (item.id !== selectedId && key && !`${item.name} ${item.category} ${item.description ?? ''}`.toLocaleLowerCase().includes(key)) continue;
        const group = groups.get(item.category) ?? [];
        group.push(item);
        groups.set(item.category, group);
    }
    return groups;
}
