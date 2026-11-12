/**
 * bunri DAW — メインDAWページ
 */
import { useDaw } from '../lib/store';
import HeaderBar from '../components/HeaderBar';
import ProgressSteps from '../components/ProgressSteps';
import LeftPanel from '../components/LeftPanel';
import CenterArea from '../components/CenterArea';
import StatusBar from '../components/StatusBar';
import WelcomeGuide from '../components/WelcomeGuide';
import GridEditor from '../components/GridEditor';
import { SongPicker } from '../components/LearnPanel';
import UndoToast from '../components/UndoToast';

/**
 * メイン DAW ページコンポーネント。
 * HeaderBar / 進み具合の段 / LeftPanel / CenterArea / StatusBar / WelcomeGuide を組み合わせて
 * DAW の全体レイアウトを構成する（縦に並べ、#main が残りの高さを使う）。
 * `showProgress` が true のときグローバルプログレスバーを表示する。
 * 原曲のファイルを選ぶ欄（SongPicker）は、画面に 1 つだけここに置く。
 * 「〜を削除しました — 元に戻す」の知らせ（UndoToast）も、ここに 1 つだけ置く。
 * @returns DAW ページ全体の JSX
 */
export default function DawPage() {
    const { showProgress, practiceOpen } = useDaw();

    return (
        // 練習画面のあいだは、左パネルと進み具合の段を隠す (外さない。CSS の .practice-mode)
        <div id="daw-layout" className={practiceOpen ? 'practice-mode' : undefined}>
            <HeaderBar />
            <ProgressSteps />
            <div id="main">
                <LeftPanel />
                <CenterArea />
            </div>
            <div id="global-progress" className={showProgress ? 'active' : ''}>
                <div className="bar" />
            </div>
            <StatusBar />
            <UndoToast />
            <SongPicker />
            <WelcomeGuide />
            <GridEditor />
        </div>
    );
}
