/**
 * bunri DAW — メインDAWページ
 */
import { useDaw } from '../lib/store';
import HeaderBar from '../components/HeaderBar';
import LeftPanel from '../components/LeftPanel';
import CenterArea from '../components/CenterArea';
import StatusBar from '../components/StatusBar';
import WelcomeGuide from '../components/WelcomeGuide';

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
