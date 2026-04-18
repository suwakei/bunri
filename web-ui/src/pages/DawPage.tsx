/**
 * bunri DAW — メインDAWページ
 */
import { useDaw } from '../lib/store';
import HeaderBar from '../components/HeaderBar';
import LeftPanel from '../components/LeftPanel';
import CenterArea from '../components/CenterArea';
import StatusBar from '../components/StatusBar';
import WelcomeGuide from '../components/WelcomeGuide';

/**
 * メイン DAW ページコンポーネント。
 * HeaderBar / LeftPanel / CenterArea / StatusBar / WelcomeGuide を組み合わせて
 * DAW の全体レイアウトを構成する。
 * `showProgress` が true のときグローバルプログレスバーを表示する。
 * @returns DAW ページ全体の JSX フラグメント
 */
export default function DawPage() {
    const { showProgress } = useDaw();

    return (
        <>
            <HeaderBar />
            <div id="main">
                <LeftPanel />
                <CenterArea />
            </div>
            <div id="global-progress" className={showProgress ? 'active' : ''}>
                <div className="bar" />
            </div>
            <StatusBar />
            <WelcomeGuide />
        </>
    );
}
