/**
 * bunri DAW — メインDAWページ
 */
import { useDaw } from '../lib/store.jsx';
import HeaderBar from '../components/HeaderBar.jsx';
import LeftPanel from '../components/LeftPanel.jsx';
import CenterArea from '../components/CenterArea.jsx';
import StatusBar from '../components/StatusBar.jsx';
import WelcomeGuide from '../components/WelcomeGuide.jsx';

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
