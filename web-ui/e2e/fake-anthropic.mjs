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
 *   POST /v1/messages               決まったガイド、差分の説明、またはアシスタントの応答を返す (呼ばれた回数に数える)
 *   POST /v1/messages/count_tokens  トークン数を返す (費用のかからない呼び出し。回数には数えない)
 *   GET  /__calls                   {"messages": 呼ばれた回数 (ガイドと説明の合計), "explain": そのうち説明の回数,
 *                                    "assistant": アシスタントの呼び出しの回数 (messages には数えない),
 *                                    "count_tokens": 数えた回数}
 *
 * ガイドか説明かは、出力の形 (output_config.format.schema) で見分ける。説明の形は `points` を持つ
 * (ガイドは `steps`)。説明は、送られてきた事実 (<facts> の JSON) の指摘の ID と小節を指して返す
 * (事実に無い場所や、事実に無いオクターブつきの音名を書くと、アプリが点ごと落とすため)。
 *
 * リクエストに `tools` が在れば、アシスタント (アプリの中のチャット。backend/assistant.py) の呼び出し。
 * 決まった筋書きで `tool_use` を返す (`assistantReply`)。状態は持たず、送られてきた会話だけから次を決める。
 * アシスタントの呼び出しに `stream: true` が付いていれば、同じ応答を Anthropic の SSE の形で少しずつ返す
 * (`streamEvents`。文は 2〜3 個の差分に分ける)。筋書きと回数の数え方は、どちらの返し方でも同じ。
 *
 * 使い方: node e2e/fake-anthropic.mjs [--port <ポート>]
 */
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 5198);

const calls = { messages: 0, explain: 0, assistant: 0, count_tokens: 0 };

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

/** メッセージの content を、ブロックの並びにする (文字列で来たら、文のブロック 1 つ)。 */
function blocksOf(message) {
    const content = message?.content;
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content : [];
}

/**
 * アシスタントの応答を、送られてきた会話から決める (筋書き)。
 *
 * いまの依頼は、最後の「文を持つ user のメッセージ」。その後ろに在る tool_result の数で、筋書きのどこまで進んだかが分かる。
 * 依頼の文に含まれることばで、筋書きを選ぶ:
 *
 * - 「クリップ」: get_project → クリップの在る最初のトラックの、最初のクリップを trim_clip で 1.5 秒までに縮める
 *   → split_clip で 1 秒の位置で分ける → 左のクリップに fade_clip でフェードイン 0.25 秒 → 文で終わる
 * - 「オクターブ」: get_project → 開いているトラックのノートを transpose_notes で 12 半音上げる → 文で終わる
 * - 「くり返」: get_project → 開いているトラックの 1〜2 小節を repeat_notes で 1 回くり返す → 文で終わる
 * - 「比べ」: get_project → 練習のトラック (無ければ開いているトラック) を check_diff で比べる → 結果の一致 (%) を言って終わる
 * - 「区間」: set_practice (2〜2 小節、75%) → 文で終わる
 * - 「どこ」: show_in_app (import_song) → 結果の where を言って終わる
 * - 「メトロノーム」: set_metronome (on) → 文で終わる
 * - 「書き出」: export_midi → 文で終わる (「WAV」も含むなら export_wav)
 * - 「保存」: save_project → 結果の名前を言って終わる
 * - 「失敗」: 在りえない track_id で add_notes を呼ぶ → 失敗の結果を受けたら、謝る文で終わる
 * - 「トラック」と「ノート」の両方: add_track → その結果の track_id に、add_notes と set_track_mix を 1 つの応答で呼ぶ
 *   → 文で終わる (1 回の依頼で、いくつも変える。結果を 1 つのメッセージにまとめて返すことも通る)
 * - 「ノート」: get_project → その結果の JSON からトラックの id を読んで (開いているトラック、無ければ最初のトラック。
 *   依頼に「ほか」と在れば、ピアノロールで開いていない最初のトラック) add_notes → 文で終わる
 * - 「トラック」: add_track → 文で終わる
 * - 「再生」: play (from_bar: 2) → 文で終わる (何も変えない依頼)
 * - どれでもない: 文だけを返す
 *
 * @returns {{ content: object[], stop_reason: string }}
 */
function assistantReply(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    let requestIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user' && blocksOf(messages[i]).some((b) => b.type === 'text')) { requestIndex = i; break; }
    }
    const request = requestIndex < 0 ? '' : blocksOf(messages[requestIndex]).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    // この依頼の中で、ここまでに返ってきたツールの結果 (古い順)
    const results = messages.slice(requestIndex + 1).filter((m) => m?.role === 'user')
        .flatMap((m) => blocksOf(m).filter((b) => b.type === 'tool_result'));
    const parsed = (result) => { try { return JSON.parse(String(result?.content ?? '')); } catch { return {}; } };
    const failed = results.some((r) => r.is_error === true);
    const stepNo = results.length;
    const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    const call = (text, ...uses) => ({
        content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...uses.map(([name, input], i) => ({ type: 'tool_use', id: `toolu_fake_${calls.assistant}_${i}`, name, input })),
        ],
        stop_reason: 'tool_use',
    });
    /** 1〜2 小節に、4 分音符を 8 個 (C2 から。2 つ目は、フラットで書く)。 */
    const bassLine = ['C2', 'Eb2', 'G2', 'C3', 'A2', 'E2', 'A2', 'G2'].map((pitch, i) => ({ pitch, step: i * 4, length: 4 }));

    /** 練習のトラック (練習画面を開いていれば)、無ければ開いているトラック、それも無ければ最初のトラック。 */
    const workTrack = (project) => project.practice?.track_id ?? project.open_track_id ?? project.tracks?.[0]?.id;
    if (request.includes('クリップ')) {
        if (stepNo === 0) return call('', ['get_project', {}]);
        const tracks = parsed(results[0]).tracks;
        const trackId = (Array.isArray(tracks) ? tracks : []).find((t) => t.clip_count > 0)?.id;
        if (stepNo === 1) return call('', ['trim_clip', { track_id: trackId, clip_index: 0, end_seconds: 1.5 }]);
        if (stepNo === 2) return call('', ['split_clip', { track_id: trackId, clip_index: 0, at_seconds: 1 }]);
        if (stepNo === 3) return call('', ['fade_clip', { track_id: trackId, clip_index: 0, fade_in_seconds: 0.25 }]);
        return say(failed ? 'すみません、クリップを変えられませんでした。' : 'クリップを 1.5 秒までに縮めて、1 秒の位置で分け、頭にフェードインを付けました。');
    }
    if (request.includes('オクターブ')) {
        if (stepNo === 0) return call('', ['get_project', {}]);
        if (stepNo === 1) return call('', ['transpose_notes', { track_id: workTrack(parsed(results[0])), semitones: 12 }]);
        return say(failed ? 'すみません、移せませんでした。' : '1 オクターブ上げました。');
    }
    if (request.includes('くり返')) {
        if (stepNo === 0) return call('', ['get_project', {}]);
        if (stepNo === 1) return call('', ['repeat_notes', { track_id: workTrack(parsed(results[0])), start_step: 0, end_step: 32 }]);
        return say(failed ? 'すみません、くり返せませんでした。' : '1〜2 小節を、もう 1 回くり返して置きました。');
    }
    if (request.includes('比べ')) {
        if (stepNo === 0) return call('', ['get_project', {}]);
        if (stepNo === 1) return call('', ['check_diff', { track_id: workTrack(parsed(results[0])) }]);
        const diff = parsed(results[1]);
        return say(failed ? 'すみません、比べられませんでした。' : `一致は ${diff.match_percent}% で、違いは ${diff.issue_count} 件です。`);
    }
    if (request.includes('区間')) {
        if (stepNo === 0) return call('', ['set_practice', { loop_start_bar: 2, loop_end_bar: 2, speed_percent: 75 }]);
        return say(failed ? 'すみません、練習の設定を変えられませんでした。' : '2 小節目を、75% の速さでくり返すようにしました。');
    }
    if (request.includes('どこ')) {
        if (stepNo === 0) return call('', ['show_in_app', { target: 'import_song' }]);
        return say(failed ? 'すみません、場所を示せませんでした。' : `${parsed(results[0]).where}です。`);
    }
    if (request.includes('メトロノーム')) {
        if (stepNo === 0) return call('', ['set_metronome', { on: true }]);
        return say('メトロノームを入れました。');
    }
    if (request.includes('書き出')) {
        const wav = request.includes('WAV');
        if (stepNo === 0) return call('', [wav ? 'export_wav' : 'export_midi', {}]);
        return say(failed ? 'すみません、書き出せませんでした。' : `${wav ? 'WAV' : 'MIDI'} ファイルを書き出しました。`);
    }
    if (request.includes('保存')) {
        if (stepNo === 0) return call('', ['save_project', {}]);
        return say(failed ? 'すみません、保存できませんでした。' : `プロジェクト「${parsed(results[0]).name ?? ''}」を保存しました。`);
    }
    if (request.includes('失敗')) {
        if (stepNo === 0) return call('ノートを置いてみます。', ['add_notes', { track_id: 987654, notes: bassLine.slice(0, 2) }]);
        return say(failed ? 'すみません、そのトラックが見つからず、ノートを置けませんでした。' : 'ノートを置きました。');
    }
    if (request.includes('トラック') && request.includes('ノート')) {
        if (stepNo === 0) return call('トラックを足します。', ['add_track', { name: 'アシスタントのベース' }]);
        if (stepNo === 1) {
            const trackId = parsed(results[0]).track_id;
            return call('', ['add_notes', { track_id: trackId, notes: bassLine }], ['set_track_mix', { track_id: trackId, gain_db: -6 }]);
        }
        return say(failed ? 'すみません、途中でできないことがありました。' : 'トラックを足して、1〜2 小節にベースを置き、音量を下げました。');
    }
    if (request.includes('ノート')) {
        if (stepNo === 0) return call('まず、プロジェクトの様子を見ます。', ['get_project', {}]);
        if (stepNo === 1) {
            const project = parsed(results[0]);
            const tracks = Array.isArray(project.tracks) ? project.tracks : [];
            const other = tracks.find((t) => t.id !== project.open_track_id);
            const trackId = request.includes('ほか') && other ? other.id : project.open_track_id ?? tracks[0]?.id;
            return call('', ['add_notes', { track_id: trackId, notes: bassLine }]);
        }
        return say(failed ? 'すみません、ノートを置けませんでした。' : '1〜2 小節に、ノートを 8 個置きました。');
    }
    if (request.includes('トラック')) {
        if (stepNo === 0) return call('', ['add_track', {}]);
        return say(failed ? 'すみません、トラックを足せませんでした。' : 'トラックを 1 本足しました。');
    }
    if (request.includes('再生')) {
        if (stepNo === 0) return call('', ['play', { from_bar: 2 }]);
        return say('2 小節目から再生しています。');
    }
    return say('これはテスト用の偽の応答です。');
}

/**
 * 文を、2〜3 個の差分に分ける (3 文字以上なら 3 個、2 文字なら 2 個)。つなぐと元の文に戻る。
 * 文字の途中 (サロゲートペアの間) では切らない。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitText(text) {
    const chars = Array.from(text);
    if (chars.length === 0) return [];
    const parts = Math.min(3, chars.length);
    const size = Math.ceil(chars.length / parts);
    const pieces = [];
    for (let i = 0; i < chars.length; i += size) pieces.push(chars.slice(i, i + size).join(''));
    return pieces;
}

/**
 * まとめて返す応答 (Messages API のメッセージ) を、少しずつ返すときのイベントの並びにする (純粋な関数)。
 *
 * Anthropic の SSE の形で、公式 SDK がそのまま読める:
 * `message_start` (中身は空の content と、入力のぶんの usage) → ブロックごとに `content_block_start` /
 * `content_block_delta` / `content_block_stop` → `message_delta` (終わり方と、出力のぶんの usage) → `message_stop`。
 * 文は `text_delta` を 2〜3 個に分ける。`tool_use` は、始まりの `input` を空にして、引数の JSON 全体を
 * `input_json_delta` 1 個で送る。SDK が組み立て直すと、元のメッセージと同じ content・stop_reason・usage になる。
 *
 * @param {{ content: object[], stop_reason: string, usage: { output_tokens: number } }} message
 * @returns {object[]} イベント (どれも `type` を持つ)
 */
function streamEvents(message) {
    const { content, stop_reason: stopReason, usage, ...head } = message;
    const events = [{
        type: 'message_start',
        // 出力のトークン数は、最後の message_delta で確定する (それまでは、始まりの 1)
        message: { ...head, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
    }];
    content.forEach((block, index) => {
        if (block.type === 'text') {
            events.push({ type: 'content_block_start', index, content_block: { ...block, text: '' } });
            for (const text of splitText(block.text)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
        } else if (block.type === 'tool_use') {
            events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        } else {
            events.push({ type: 'content_block_start', index, content_block: block });
        }
        events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    events.push({ type: 'message_stop' });
    return events;
}

/** イベント 1 つを、SSE の 1 まとまり (`event:` と `data:` の行、空行で終わる) にする (純粋な関数)。 */
function sseFrame(event) {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'request-id': 'req_fake' });
    res.end(text);
}

/** イベントの並びを、SSE (`text/event-stream`) で 1 つずつ書いて返す。 */
function sendStream(res, events) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' });
    for (const event of events) res.write(sseFrame(event));
    res.end();
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
        if (req.method === 'POST' && path === '/v1/messages' && Array.isArray(body.tools) && body.tools.length > 0) {
            // アシスタント。ガイドと説明の回数 (messages) には数えない (それらのテストが、回数の増え方を見ているため)
            calls.assistant += 1;
            const message = {
                id: `msg_fake_assistant_${calls.assistant}`,
                type: 'message',
                role: 'assistant',
                model: body.model ?? 'claude-opus-5-5',
                ...assistantReply(body),
                stop_sequence: null,
                usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000, output_tokens: 60 },
            };
            // 少しずつ返す呼び出し (stream: true) には、同じ応答を SSE で返す。それ以外は、今までどおり JSON 1 つ
            return body.stream === true ? sendStream(res, streamEvents(message)) : send(res, 200, message);
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
