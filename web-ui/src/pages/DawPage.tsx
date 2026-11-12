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
import MissingAudioBar from '../components/MissingAudioBar';
import ProjectDialogs from '../components/ProjectDialogs';
import { usePracticeProjectSection } from '../lib/practice-project';

/**
 * メイン DAW ページコンポーネント。
 * HeaderBar / 進み具合の段 / LeftPanel / CenterArea / StatusBar / WelcomeGuide を組み合わせて
 * DAW の全体レイアウトを構成する（縦に並べ、#main が残りの高さを使う）。
 * `showProgress` が true のときグローバルプログレスバーを表示する。
 * 原曲のファイルを選ぶ欄（SongPicker）は、画面に 1 つだけここに置く。
 * 「〜を削除しました — 元に戻す」の知らせ（UndoToast）と、プロジェクトの操作が尋ねる窓（ProjectDialogs）も、ここに 1 つだけ置く。
 * 音声の無いクリップ（以前の形式から開いた）が在れば、進み具合の下に知らせる（MissingAudioBar）。
 * 練習画面の状態をプロジェクトに入れる節（lib/practice-project.ts）も、ここで 1 つだけ登録する。
 * @returns DAW ページ全体の JSX
 */
export default function DawPage() {
    const { showProgress, practiceOpen } = useDaw();
    usePracticeProjectSection();

    return (
        // 練習画面のあいだは、左パネルと進み具合の段を隠す (外さない。CSS の .practice-mode)
        <div id="daw-layout" className={practiceOpen ? 'practice-mode' : undefined}>
            <HeaderBar />
            <ProgressSteps />
            <MissingAudioBar />
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
            <ProjectDialogs />
        </div>
    );
}
