#!/usr/bin/env node
/**
 * テスト用の、偽の Claude API サーバ。
 *
 * ブラウザのテストで再現ガイドを通すとき、本物の Claude を呼ぶと費用がかかる。そこで API サーバには
 * 環境変数 ANTHROPIC_BASE_URL でこのサーバを向かせ、決まった応答を返す (playwright.config.ts)。
 * アプリ側のコードには手を入れていない。公式 SDK が、そのままここへリクエストを送ってくる。
 *
 * 呼ばれた回数を数えているので、テストは「Claude を呼んだか・呼ばなかったか」を直接確かめられる。
 *
 *   POST /v1/messages               決まったガイド、または差分の説明を返す (呼ばれた回数に数える)
 *   POST /v1/messages/count_tokens  トークン数を返す (費用のかからない呼び出し。回数には数えない)
 *   GET  /__calls                   {"messages": 呼ばれた回数 (ガイドと説明の合計), "explain": そのうち説明の回数,
 *                                    "count_tokens": 数えた回数}
 *
 * ガイドか説明かは、出力の形 (output_config.format.schema) で見分ける。説明の形は `points` を持つ
 * (ガイドは `steps`)。説明は、送られてきた事実 (<facts> の JSON) の指摘の ID と小節を指して返す
 * (事実に無い場所や、事実に無いオクターブつきの音名を書くと、アプリが点ごと落とすため)。
 *
 * 使い方: node e2e/fake-anthropic.mjs [--port <ポート>]
 */
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 5198);

const calls = { messages: 0, explain: 0, count_tokens: 0 };

/** どのカルテにも当てはまる、決まったガイド (1 小節 1 拍目は、解析できた曲なら必ず在る)。 */
const GUIDE = {
    overview: 'これはテスト用の偽の応答です。',
    steps: [
        { title: 'テンポを合わせる', topic: 'grid', body: 'カルテのテンポに合わせます。', refs: [{ section_id: null, bar: 1, beat: 1 }] },
        { title: '構成を並べる', topic: 'sections', body: 'カルテの構成のとおりに区切ります。', refs: [{ section_id: null, bar: 1, beat: null }] },
        { title: '音量をそろえる', topic: 'mix', body: 'カルテのラウドネスを目安にします。', refs: [] },
    ],
    cautions: [],
};

/**
 * 差分の説明 (backend/coach_explain.py の COACH_SCHEMA の形) を、送られてきた事実から作る。
 * 1 つ目の点は最初の指摘を、2 つ目の点は 2 つ目の指摘の小節だけを指す。音名は書かない。
 * 事実に強さの違い (facts.velocity。お手本が MIDI ファイルから読み込んだもののときだけ在る) が入っていれば、
 * その 1 つ目のまとまりの小節を指す点を足す (強さの事実が Claude まで届いたかを、テストが画面で確かめられる)。
 */
function explanationFor(body) {
    const content = String(body.messages?.[0]?.content ?? '');
    const start = content.indexOf('<facts>\n');
    const end = content.indexOf('\n</facts>');
    let facts = {};
    try { facts = JSON.parse(content.slice(start + '<facts>\n'.length, end)); } catch { /* 事実が読めなければ空 */ }
    const rows = facts.issues?.rows ?? [];
    const [firstId, firstBar] = rows[0] ?? ['i1', 1];
    const points = [{
        title: 'お手本との違いが続く場所を見直す',
        observation: `これはテスト用の偽の説明です。${firstBar} 小節目から、お手本と違うノートが続いています。`,
        cause: '拍の数え方がずれたのかもしれません。',
        fix: `${firstBar} 小節目を開いて、お手本の水色のノートと見比べてください。`,
        issue_ids: [firstId],
        bars: [firstBar],
    }];
    if (rows[1]) {
        points.push({
            title: '次の小節もそろえる',
            observation: `${rows[1][1]} 小節目にも違いがあります。`,
            cause: '同じ理由かもしれません。',
            fix: 'お手本を重ねて、位置をそろえてください。',
            issue_ids: [],
            bars: [rows[1][1]],
        });
    }
    const strength = facts.velocity?.findings?.[0];
    if (strength) {
        points.push({
            title: '強さを見直す',
            observation: `${strength.start_bar} 小節目から、強さがお手本と違っています（まとまり ${facts.velocity.findings.length} 個）。`,
            cause: 'マウスで置いたノートは、強さが同じになるからかもしれません。',
            fix: 'ノートを選んで、強さの欄で変えてください。',
            issue_ids: [],
            bars: [strength.start_bar],
        });
    }
    return {
        summary: 'これはテスト用の偽の説明です。お手本との違いが、いくつかの小節にまとまっています。',
        points,
        next_step: `まず ${firstBar} 小節目を開いて、お手本と見比べてください。`,
        next_step_bar: firstBar,
    };
}

function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'request-id': 'req_fake' });
    res.end(text);
}

const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        if (req.method === 'GET' && path === '/__calls') return send(res, 200, calls);
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* 本文が JSON でなければ空として扱う */ }
        if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
            calls.count_tokens += 1;
            return send(res, 200, { input_tokens: 1000 });
        }
        if (req.method === 'POST' && path === '/v1/messages') {
            calls.messages += 1;
            const explain = Boolean(body.output_config?.format?.schema?.properties?.points);
            if (explain) calls.explain += 1;
            return send(res, 200, {
                id: `msg_fake_${calls.messages}`,
                type: 'message',
                role: 'assistant',
                model: body.model ?? 'claude-opus-5-5',
                content: [{ type: 'text', text: JSON.stringify(explain ? explanationFor(body) : GUIDE) }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 20, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 400 },
            });
        }
        return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `偽のサーバには無い経路です: ${req.method} ${path}` } });
    });
});

server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', url: `http://127.0.0.1:${port}` })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
