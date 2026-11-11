//! MIDI キーボードからの入力。
//!
//! ブラウザ版は Web MIDI API で受けるが、mac の WebView (WKWebView) は Web MIDI を持たない。
//! そこでデスクトップ版では、ここ (Rust) で OS の MIDI を受けて、画面にイベントで渡す。
//! 画面側は、受け取ったバイト列をブラウザ版と同じ経路で処理する (web-ui/src/lib/midi-input.ts)。
//!
//! - つながっている入力ポートを **すべて** 開く。どの鍵盤を弾いても入るようにするため
//! - 接続は専用のスレッドが持つ。OS によっては接続をスレッド間で受け渡せないため
//! - 機器の抜き差しは自動では追わない。画面の「再検出」で開き直す

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

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
    /// `on_message` は MIDI メッセージを受けるたびに、OS の MIDI スレッドから呼ばれる。
    pub fn start<F>(&self, on_message: F) -> Result<Vec<String>, String>
    where
        F: Fn(&[u8]) + Send + Clone + 'static,
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
    F: Fn(&[u8]) + Send + Clone + 'static,
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
        match input.connect(
            port,
            "bunri-input",
            move |_stamp, message, _| on_message(message),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

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
                .start(move |message| sink.lock().unwrap().push(message.to_vec()))
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
