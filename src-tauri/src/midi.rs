//! MIDI キーボードからの入力。
//!
//! ブラウザ版は Web MIDI API で受けるが、mac の WebView (WKWebView) は Web MIDI を持たない。
//! そこでデスクトップ版では、ここ (Rust) で OS の MIDI を受けて、画面にイベントで渡す。
//! 画面側は、受け取ったバイト列をブラウザ版と同じ経路で処理する (web-ui/src/lib/midi-input.ts)。
//!
//! - つながっている入力ポートを **すべて** 開く。どの鍵盤を弾いても入るようにするため
//! - 接続は専用のスレッドが持つ。OS によっては接続をスレッド間で受け渡せないため
//! - 機器の抜き差しは自動では追わない。画面の「再検出」で開き直す
//! - 受け取る側には、メッセージと一緒に **ポートの名前** も渡す。画面に渡すのはバイト列だけだが、
//!   動きの記録 (`activity.rs`) にはポートの名前つきで残す。どのポートから来たか (同じ鍵盤が USB と
//!   Bluetooth の両方で送ってきていないか、など) は、その記録でしか分からない

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use midir::{Ignore, MidiInput};

/// 画面に送るイベントの名前。中身は MIDI メッセージのバイト列 (`[status, data1, data2]`)。
pub const EVENT: &str = "midi-message";

/// OS に見せるクライアント名。
const CLIENT_NAME: &str = "bunri";

/// 開いている MIDI 入力。Tauri の state として管理する。
#[derive(Default)]
pub struct MidiInputs {
    /// 接続を持っているスレッドへの「止めて」の合図。開いていなければ `None`。
    stop: Mutex<Option<Sender<()>>>,
}

impl MidiInputs {
    /// つながっている入力ポートをすべて開き、開けたポートの名前を返す。
    ///
    /// すでに開いていれば、いったん閉じて開き直す (機器を挿し直したあとの再検出に使う)。
    /// ポートが 1 つも無くても失敗にはしない (空のリストを返す)。
    ///
    /// `on_message` は MIDI メッセージを受けるたびに、OS の MIDI スレッドから呼ばれる
    /// (引数は、届いたポートの名前と、メッセージのバイト列)。
    pub fn start<F>(&self, on_message: F) -> Result<Vec<String>, String>
    where
        F: Fn(&str, &[u8]) + Send + Clone + 'static,
    {
        self.stop();

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Vec<String>, String>>();
        thread::Builder::new()
            .name("midi-input".into())
            .spawn(move || {
                let opened = open_all(on_message);
                let connections = match opened {
                    Ok((names, connections)) => {
                        let _ = ready_tx.send(Ok(names));
                        connections
                    }
                    Err(reason) => {
                        let _ = ready_tx.send(Err(reason));
                        return;
                    }
                };
                // 止める合図 (または送り手が居なくなる) まで、接続を持ったまま待つ
                let _ = stop_rx.recv();
                drop(connections);
            })
            .map_err(|e| format!("MIDI 入力のスレッドを作れません: {e}"))?;

        let names = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "MIDI 入力の準備が終わりませんでした".to_string())??;
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop_tx);
        Ok(names)
    }

    /// 開いている入力を閉じる。開いていなければ何もしない。
    pub fn stop(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stop.send(());
        }
    }
}

/// つながっている入力ポートをすべて開く。
///
/// 1 つのクライアントは 1 つのポートにしか接続できないので、ポートごとにクライアントを作る。
/// 開けなかったポートは飛ばし、理由をログに出す (1 台が開けなくても、ほかは使えるように)。
fn open_all<F>(on_message: F) -> Result<(Vec<String>, Vec<midir::MidiInputConnection<()>>), String>
where
    F: Fn(&str, &[u8]) + Send + Clone + 'static,
{
    let port_count = MidiInput::new(CLIENT_NAME)
        .map_err(|e| format!("MIDI を使えません: {e}"))?
        .ports()
        .len();

    let mut names = Vec::new();
    let mut connections = Vec::new();
    for index in 0..port_count {
        let mut input =
            MidiInput::new(CLIENT_NAME).map_err(|e| format!("MIDI を使えません: {e}"))?;
        // タイミングクロックやアクティブセンシングは絶えず流れてくるので受け取らない
        input.ignore(Ignore::All);
        let ports = input.ports();
        let Some(port) = ports.get(index) else {
            continue;
        };
        let name = input
            .port_name(port)
            .unwrap_or_else(|_| format!("MIDI 入力 {}", index + 1));
        let on_message = on_message.clone();
        let port_name = name.clone();
        match input.connect(
            port,
            "bunri-input",
            move |_stamp, message, _| on_message(&port_name, message),
            (),
        ) {
            Ok(connection) => {
                names.push(name);
                connections.push(connection);
            }
            Err(e) => eprintln!("[midi] {name} を開けません: {e}"),
        }
    }
    Ok((names, connections))
}

/// MIDI メッセージを、記録用の短い文にする (`note-on ch1 60(C4) vel 96` など)。
///
/// 鍵盤の操作・コントロールチェンジ・ピッチベンドは読める形に、それ以外はバイト列の 16 進にする。
/// 強さ 0 の note-on は、画面側と同じく note-off として扱う (`web-ui/src/lib/midi-input.ts`)。
pub fn describe(message: &[u8]) -> String {
    let hex = || {
        message
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let [status, data1, data2] = *message else {
        return hex();
    };
    let channel = (status & 0x0f) + 1;
    let (data1, data2) = (data1 & 0x7f, data2 & 0x7f);
    match status & 0xf0 {
        0x90 if data2 > 0 => format!(
            "note-on ch{channel} {data1}({}) vel {data2}",
            note_name(data1)
        ),
        0x80 | 0x90 => format!("note-off ch{channel} {data1}({})", note_name(data1)),
        0xb0 => format!("cc ch{channel} {data1}={data2}"),
        0xe0 => format!(
            "pitch-bend ch{channel} {}",
            (i32::from(data2) << 7 | i32::from(data1)) - 8192
        ),
        _ => hex(),
    }
}

/// 同じ種類のメッセージが続くときに、動きの記録に残すものを間引く。
///
/// 鍵盤を押した・離したは、すべて残す。ペダルやスイッチ (コントロールチェンジの 64〜69。踏んだ・離したの 2 つの値を
/// 取るもの) も、すべて残す (間引くと、離した行が落ちて踏みっぱなしに見える)。
/// それ以外 (つまみ、ホイール、アフタータッチなど) は、動かしているあいだ 1 秒に何十も届くので、
/// 同じポートの同じ種類 (同じチャンネルの同じつまみ) は決まった間隔に 1 つだけ残す。
/// ポートごとに数えるので、同じ鍵盤が 2 つのポートから同じものを送ってきたときは、両方が残る。
/// 画面に渡すメッセージは間引かない (間引くのは記録だけ)。
#[derive(Default)]
pub struct RepeatFilter {
    /// ポートごと・種類ごとの、最後に記録に残した時刻。
    last: HashMap<String, HashMap<(u8, u8), Instant>>,
}

impl RepeatFilter {
    /// 同じ種類を、この間隔に 1 つだけ残す。
    const INTERVAL: Duration = Duration::from_millis(500);

    /// このメッセージを記録に残すか。
    ///
    /// @param port - 届いたポートの名前
    pub fn should_record(&mut self, port: &str, message: &[u8], now: Instant) -> bool {
        let Some(&status) = message.first() else {
            return false;
        };
        let kind = status & 0xf0;
        if kind == 0x80 || kind == 0x90 {
            return true;
        }
        let data1 = message.get(1).copied().unwrap_or(0);
        if kind == 0xb0 && (64..=69).contains(&data1) {
            return true;
        }
        // コントロールチェンジと鍵盤ごとのアフタータッチは、2 バイト目 (どのつまみ・どの鍵盤か) も種類に含める
        let detail = if kind == 0xa0 || kind == 0xb0 {
            data1
        } else {
            0
        };
        if !self.last.contains_key(port) {
            self.last.insert(port.to_string(), HashMap::new());
        }
        let seen = self.last.get_mut(port).expect("直前に入れた");
        match seen.get(&(status, detail)) {
            Some(last) if now.duration_since(*last) < Self::INTERVAL => false,
            _ => {
                seen.insert((status, detail), now);
                true
            }
        }
    }
}

/// MIDI ノート番号を、音名とオクターブにする (60 → C4)。
fn note_name(pitch: u8) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    format!(
        "{}{}",
        NAMES[usize::from(pitch % 12)],
        i32::from(pitch / 12) - 1
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn メッセージを記録用の文にする() {
        assert_eq!(describe(&[0x90, 60, 96]), "note-on ch1 60(C4) vel 96");
        assert_eq!(describe(&[0x99, 36, 127]), "note-on ch10 36(C2) vel 127");
        // 強さ 0 の note-on は、離したものとして扱う
        assert_eq!(describe(&[0x90, 60, 0]), "note-off ch1 60(C4)");
        assert_eq!(describe(&[0x81, 69, 64]), "note-off ch2 69(A4)");
        assert_eq!(describe(&[0xb0, 64, 127]), "cc ch1 64=127");
        assert_eq!(describe(&[0xe0, 0, 64]), "pitch-bend ch1 0");
        assert_eq!(describe(&[0xe0, 0, 0]), "pitch-bend ch1 -8192");
        // それ以外と、長さが 3 でないものは 16 進のまま
        assert_eq!(describe(&[0xc0, 5]), "C0 05");
        assert_eq!(describe(&[0xa0, 60, 10]), "A0 3C 0A");
        assert_eq!(describe(&[]), "");
        assert_eq!(describe(&[0x90, 0, 1]), "note-on ch1 0(C-1) vel 1");
    }

    #[test]
    fn 鍵盤の操作はすべて記録し_つまみは間引く() {
        let mut filter = RepeatFilter::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        // 押した・離したは、続けて来てもすべて残す
        assert!(filter.should_record("usb", &[0x90, 60, 96], at(0)));
        assert!(filter.should_record("usb", &[0x90, 60, 96], at(1)));
        assert!(filter.should_record("usb", &[0x80, 60, 0], at(2)));
        // 同じつまみは、間隔のあいだ 1 つだけ
        assert!(filter.should_record("usb", &[0xb0, 1, 10], at(10)));
        assert!(!filter.should_record("usb", &[0xb0, 1, 11], at(20)));
        assert!(!filter.should_record("usb", &[0xb0, 1, 12], at(509)));
        assert!(filter.should_record("usb", &[0xb0, 1, 13], at(510)));
        // 別のつまみ・別のチャンネルは、別に数える
        assert!(filter.should_record("usb", &[0xb0, 7, 1], at(511)));
        assert!(filter.should_record("usb", &[0xb1, 1, 1], at(512)));
        // ピッチベンドは、値が変わっても同じ種類
        assert!(filter.should_record("usb", &[0xe0, 0, 64], at(600)));
        assert!(!filter.should_record("usb", &[0xe0, 5, 70], at(700)));
        // 空のメッセージは残さない
        assert!(!filter.should_record("usb", &[], at(800)));
    }

    #[test]
    fn 別のポートから届いた同じメッセージは_両方とも記録する() {
        // 同じ鍵盤が USB と Bluetooth の両方で送ってきていることを、記録で確かめられるように
        let mut filter = RepeatFilter::default();
        let now = Instant::now();
        assert!(filter.should_record("usb", &[0xb0, 1, 10], now));
        assert!(filter.should_record("bluetooth", &[0xb0, 1, 10], now));
        assert!(!filter.should_record("usb", &[0xb0, 1, 11], now));
        assert!(!filter.should_record("bluetooth", &[0xb0, 1, 11], now));
    }

    #[test]
    fn ペダルは_踏んだ行も離した行も記録する() {
        let mut filter = RepeatFilter::default();
        let start = Instant::now();
        // サステインペダル (64) を踏んで、すぐ離す。離した行を落とすと、踏みっぱなしに見える
        assert!(filter.should_record("usb", &[0xb0, 64, 127], start));
        assert!(filter.should_record("usb", &[0xb0, 64, 0], start + Duration::from_millis(100)));
        assert!(filter.should_record("usb", &[0xb0, 69, 127], start + Duration::from_millis(101)));
        // 64〜69 の外は、つまみとして間引く
        assert!(filter.should_record("usb", &[0xb0, 70, 1], start));
        assert!(!filter.should_record("usb", &[0xb0, 70, 2], start + Duration::from_millis(100)));
    }

    #[test]
    fn 開いていないときに止めても何も起きない() {
        let inputs = MidiInputs::default();
        inputs.stop();
        inputs.stop();
    }

    /// OS の MIDI を実際に通して確かめる。仮想の出力ポートを作り、そこへ送ったメッセージが
    /// `start` に渡した関数まで届くこと、`stop` のあとは届かないことを見る。
    ///
    /// 鍵盤が無くても走る。mac の CoreMIDI が要るので、普段のテストでは走らせない
    /// (`cargo test -- --ignored 仮想ポート`)。
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "OS の MIDI (CoreMIDI) を使う"]
    fn 仮想ポートから送ったメッセージが届く() {
        use midir::os::unix::VirtualOutput;
        use midir::MidiOutput;

        let port_name = format!("bunri-test-{}", std::process::id());
        let mut out = MidiOutput::new("bunri-test")
            .unwrap()
            .create_virtual(&port_name)
            .expect("仮想ポートを作れません");

        let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        let sink = Arc::clone(&received);
        let inputs = MidiInputs::default();

        // 作ったばかりのポートが一覧に出るまで、少し待つことがある
        let deadline = Instant::now() + Duration::from_secs(5);
        let names = loop {
            let sink = Arc::clone(&sink);
            let names = inputs
                .start(move |_port, message| sink.lock().unwrap().push(message.to_vec()))
                .unwrap();
            if names.iter().any(|n| n.contains(&port_name)) || Instant::now() > deadline {
                break names;
            }
            thread::sleep(Duration::from_millis(100));
        };
        assert!(
            names.iter().any(|n| n.contains(&port_name)),
            "仮想ポートが一覧に無い: {names:?}"
        );

        let wait_for = |count: usize| {
            let deadline = Instant::now() + Duration::from_secs(3);
            while received
                .lock()
                .unwrap()
                .iter()
                .filter(|m| m[1] == 61 || m[1] == 62)
                .count()
                < count
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(20));
            }
        };
        out.send(&[0x90, 61, 100]).unwrap();
        out.send(&[0x80, 61, 0]).unwrap();
        wait_for(2);
        let ours: Vec<Vec<u8>> = received
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m[1] == 61)
            .cloned()
            .collect();
        assert_eq!(ours, [vec![0x90, 61, 100], vec![0x80, 61, 0]]);

        // 止めたあとは届かない
        inputs.stop();
        thread::sleep(Duration::from_millis(200));
        out.send(&[0x90, 62, 100]).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(
            !received.lock().unwrap().iter().any(|m| m[1] == 62),
            "止めたあとも届いている"
        );
    }
}
