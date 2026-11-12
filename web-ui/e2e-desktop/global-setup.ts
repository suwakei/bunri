/**
 * 本物の窓を操作するテストの準備と後片付け (vitest の globalSetup)。
 *
 * テスト用のビルドのアプリを 1 つ起動して (launch.ts)、全部のテストで使う。
 * 終わったら窓を閉じてアプリを終わらせ、sidecar まで終わったことを確かめる
 * (アプリが閉じたあとに sidecar が残っていたら、それを止めてから失敗にする)。
 *
 * アプリの出力は e2e-desktop-results/app.log に残す (失敗したときに読む)。
 * 環境変数 BUNRI_E2E_KEEP=1 を付けると、一時ディレクトリ (データ置き場、書き出したファイル) を消さずに残す。
 */
import type { TestProject } from 'vitest/node';
import { launchApp } from './launch.ts';

declare module 'vitest' {
    export interface ProvidedContext {
        /** アプリの中の WebDriver サーバのポート。 */
        webdriverPort: number;
        /** sidecar のデータ置き場 (BUNRI_DATA_DIR)。 */
        dataDir: string;
        /** 書き出したファイルの保存先。 */
        downloadDir: string;
        /** 偽の Claude サーバの URL。 */
        fakeLlmUrl: string;
    }
}

export default async function setup(project: TestProject) {
    const app = await launchApp();
    project.provide('webdriverPort', app.webdriverPort);
    project.provide('dataDir', app.dataDir);
    project.provide('downloadDir', app.downloadDir);
    project.provide('fakeLlmUrl', app.fakeLlmUrl);

    return async () => {
        const problems = await app.stop({ keep: Boolean(process.env.BUNRI_E2E_KEEP) });
        if (problems.length > 0) throw new Error(`${problems.join('\n')}\nアプリの出力: ${app.logFile}`);
    };
}
