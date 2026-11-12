/**
 * bunri DAW — DAW の画面で、時間のかかる処理（ジョブ）の進み具合のカードを見せる。
 *
 * カードは、処理を始めたボタンの在る場所に出る。ステータスバーの小さな表示や、始めようとして断られたときの
 * 「実行中の処理を見る」から、その場所（タブ・段・グリッドの補正）を開き、カードまでスクロールする。
 */
import { useCallback } from 'react';
import { useDaw } from './store';
import { jobTracker, slotOf, type Job, type JobSlot } from './jobs';

/** DAW の画面の中に、カードを出す場所が在るか（ツールの画面で始めた処理は、DAW の画面にカードが無い）。 */
export function hasDawCard(slot: JobSlot | null): slot is JobSlot {
    return slot === 'learn-song' || slot === 'learn-parts' || slot === 'grid' || slot === 'file-analyze';
}

/**
 * ジョブのカードを開いて見せる関数を返す。DAW の画面にカードが無いジョブ（ツールの画面で始めたものなど）なら、
 * ステータスバーの小さな表示の「中止」へ移り、false を返す。
 */
export function useShowJob(): (job: Job) => boolean {
    const { openLearn, setShowGridEditor, setLeftTab } = useDaw();
    return useCallback((job: Job) => {
        const slot = slotOf(job);
        if (!hasDawCard(slot)) {
            document.querySelector<HTMLElement>('#job-indicator .job-cancel')?.focus();
            return false;
        }
        if (slot === 'learn-song' || slot === 'learn-parts') openLearn('song');
        else if (slot === 'grid') setShowGridEditor(true);
        else setLeftTab('file');
        jobTracker.requestFocus(slot);
        return true;
    }, [openLearn, setShowGridEditor, setLeftTab]);
}
