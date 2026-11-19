import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// waitFor / findBy の待ち時間 (既定は 1 秒)。全部のテストファイルを並列に回すと jsdom の描画が遅くなり、
// 単独では通るテストが、待ち時間切れで時々落ちていた (2026-11-19。毎回違うテストが落ちる)。
// 延びるのは、条件が満たされないときに待つ時間だけで、通るテストの速さは変わらない
configure({ asyncUtilTimeout: 5000 });
