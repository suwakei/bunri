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
 *   POST /v1/messages               決まったガイドを返す (呼ばれた回数に数える)
 *   POST /v1/messages/count_tokens  トークン数を返す (費用のかからない呼び出し。回数には数えない)
 *   GET  /__calls                   {"messages": ガイドを作った回数, "count_tokens": 数えた回数}
 *
 * 使い方: node e2e/fake-anthropic.mjs [--port <ポート>]
 */
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 5198);

const calls = { messages: 0, count_tokens: 0 };

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
            return send(res, 200, {
                id: `msg_fake_${calls.messages}`,
                type: 'message',
                role: 'assistant',
                model: body.model ?? 'claude-opus-5-5',
                content: [{ type: 'text', text: JSON.stringify(GUIDE) }],
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
