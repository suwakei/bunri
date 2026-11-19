//! bunri DAW のデスクトップアプリ (ネイティブ側)。
//!
//! 役割は次のものだけ。
//!
//! - 画面 (web-ui の React) を表示する窓を開く
//! - Python sidecar (今までの FastAPI) を起動し、見張り、アプリと一緒に終わらせる。
//!   配布物では、その前に Python 環境を用意する (初回セットアップ)
//! - sidecar のポートとトークンを画面に渡す (sidecar が止まったら、画面の求めで起動し直して渡し直す)
//! - MIDI キーボードの入力を受けて画面に渡す (WebView が Web MIDI を持たないため)
//! - 動きの記録 (いま何が起きたか) をファイルに残す。利用者が見るためのもので、エージェントも同じものを読む (`activity.rs`)
//! - プロジェクトのファイル (`.bunri`) を、利用者が選んだ場所とデータ置き場の間で写す。
//!   保存していない変更が在るときに、窓を閉じる前に画面に尋ねさせる (`project.rs`)
//! - 音を鳴らす: 画面の再生・停止・位置・区間ループ・メトロノーム・録音前のカウント・鍵盤の試聴を、
//!   音のエンジン (crate `bunri-audio`。`audio-engine/`) につなぐ (`audio.rs`)
//!
//! AI・音声の解析は Python、画面は Web のまま。ここには書き直さない。
//!
//! 音を作る部分 (engine・サンプラー・再生の状態・cpal での出力) は、Tauri 抜きでテストできるよう
//! 別の crate (`bunri-audio`) に在る。このクレートの `audio.rs` は、command / event とのつなぎだけを持つ。
//! 書き出し・録音・音声のデコードは、まだ画面側 (Web Audio) のまま。

// 窓を自動操作するテスト用の仕掛け (WebDriver サーバ) は、配布物に入れてはいけない。
// 開発用のビルド (debug) でしか有効にできないようにする。docs/desktop-architecture.md「窓を自動操作するテスト」
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!(
    "機能 e2e (窓を自動操作する WebDriver サーバ) は release ビルドでは使えません。配布物に入れないでください"
);

mod activity;
mod audio;
#[cfg(feature = "e2e")]
mod e2e;
mod instruments;
mod midi;
mod project;
mod secrets;
mod sidecar;
mod windows;

use sidecar::{BackendInfo, BootStatus, LaunchConfig, Sidecar};
use tauri::{Manager, RunEvent, State, WindowEvent};

/// 画面に sidecar の接続先 (ポート) とトークンを渡す。
///
/// sidecar が待ち受けを始めるまで待つ。起動に失敗していたら、理由を文字列で返す。
#[tauri::command]
async fn backend_info(sidecar: State<'_, Sidecar>) -> Result<BackendInfo, String> {
    sidecar.wait_ready().await
}

/// 起動の進み具合を返す。画面が起動待ちの間に繰り返し呼び、セットアップの様子を表示する。
#[tauri::command]
fn boot_status(sidecar: State<'_, Sidecar>) -> BootStatus {
    sidecar.status()
}

/// sidecar を起動し直し、新しい接続先 (ポート) とトークンを返す。
///
/// 画面が、sidecar が止まった (応答しない) ことに気づいて「再起動」を押したときと、
/// 起動に失敗した画面で「再試行」を押したときに呼ぶ。待ち受けを始めるまで待つ。
/// 起動し直せなかったら、理由を文字列で返す。
#[tauri::command]
async fn restart_backend(sidecar: State<'_, Sidecar>) -> Result<BackendInfo, String> {
    sidecar.restart()?;
    sidecar.wait_ready().await
}

/// Claude の API キーを、OS のキーチェーンに保存する。
///
/// 次回の起動から、sidecar に環境変数で渡される。いま動いている sidecar には、
/// 画面が別途 API で渡す (web-ui/src/lib/guide.ts)。
#[tauri::command]
fn save_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    secrets::save(&keychain_service(&app), &key)
}

/// キーチェーンに保存した Claude の API キーを消す。
#[tauri::command]
fn delete_api_key(app: tauri::AppHandle) -> Result<(), String> {
    secrets::delete(&keychain_service(&app))
}

/// API キーを置く、キーチェーン上のサービス名 (アプリの識別子)。
#[cfg(not(feature = "e2e"))]
fn keychain_service(app: &tauri::AppHandle) -> String {
    app.config().identifier.clone()
}

/// テスト用のビルドでは、利用者の本物の項目に触れないよう別の名前にする。
#[cfg(feature = "e2e")]
fn keychain_service(app: &tauri::AppHandle) -> String {
    e2e::keychain_service(&app.config().identifier)
}

/// ネイティブ側で起きたことを、動きの記録に残して、画面 (「記録」の一覧) にも渡す。
fn note_activity(app: &tauri::AppHandle, tag: &str, message: &str) {
    use tauri::Emitter;
    let entry = app.state::<activity::ActivityLog>().record(tag, message);
    let _ = app.emit(activity::EVENT, entry);
}

/// 画面で起きたこと (操作、ステータスバーの文、API の呼び出しなど) を、動きの記録に 1 行残す。
///
/// `echo` が真なら、イベント `activity` で画面にも渡す。画面の外から足す行 (エージェントが窓を操作するときの
/// 「いまから何をするか」) を、利用者が見ている「記録」の一覧にも出すため。画面が自分で送る行には付けない
/// (画面はもう自分の一覧に入れている)。
#[tauri::command]
fn activity_record(
    app: tauri::AppHandle,
    log: State<'_, activity::ActivityLog>,
    tag: String,
    message: String,
    echo: Option<bool>,
) {
    use tauri::Emitter;
    let entry = log.record(&tag, &message);
    if echo.unwrap_or(false) {
        let _ = app.emit(activity::EVENT, entry);
    }
}

/// 動きの記録について、画面に知らせること。
#[derive(serde::Serialize)]
struct ActivityInfo {
    /// 記録のファイルの場所。記録していなければ `null`。
    path: Option<String>,
}

/// 動きの記録のファイルの場所を返す (画面の「記録」の一覧に出す)。
#[tauri::command]
fn activity_info(log: State<'_, activity::ActivityLog>) -> ActivityInfo {
    ActivityInfo {
        path: log.path().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// MIDI 入力を開く。つながっている入力ポートをすべて開き、開けたポートの名前を返す。
///
/// 受けたメッセージは、イベント `midi-message` で画面に送る (中身はバイト列)。
/// すでに開いていれば開き直すので、機器を挿し直したあとの再検出にも使う。
///
/// 開いたポートと、届いたメッセージは、ポートの名前つきで動きの記録に残す (つまみを回したときのように
/// 同じ種類が続くものは間引く。`midi::RepeatFilter`)。
///
/// 記録は、OS の MIDI スレッドでは行わない。MIDI スレッドは、画面へメッセージを送ったあと、記録する文を
/// 別のスレッドへ渡すだけにする。デスクトップ版は届いた時刻を画面に渡さないので、ここでファイルへの書き込みや
/// 錠を待つと、そのぶん発音と録る位置が遅れるため。
#[tauri::command]
fn midi_start(
    app: tauri::AppHandle,
    inputs: State<'_, midi::MidiInputs>,
) -> Result<Vec<String>, String> {
    use std::sync::{mpsc, Arc, Mutex};
    use tauri::Emitter;

    // 記録を受け持つスレッド。送り手 (MIDI のコールバック) が全部居なくなると (= 入力を閉じると) 終わる
    let (lines, incoming) = mpsc::channel::<String>();
    let writer = app.clone();
    std::thread::Builder::new()
        .name("midi-activity".into())
        .spawn(move || {
            for line in incoming {
                note_activity(&writer, "midi-in", &line);
            }
        })
        .map_err(|e| format!("MIDI の記録のスレッドを作れません: {e}"))?;

    let repeats = Arc::new(Mutex::new(midi::RepeatFilter::default()));
    let duplicates = Arc::new(Mutex::new(midi::DuplicateFilter::default()));
    let handle = app.clone();
    let names = inputs.start(move |port, message| {
        let now = std::time::Instant::now();
        // 同じ鍵盤が別のポートからも同じものを送ってきたら、画面には 1 回だけ渡す
        let duplicate = duplicates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_duplicate(port, message, now);
        // 先に画面へ渡す (音を鳴らす・ノートを置くほうを、記録より優先する)
        if !duplicate {
            let _ = handle.emit(midi::EVENT, message.to_vec());
        }
        let record = repeats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .should_record(port, message, now);
        if record {
            // 記録には、どのポートから届いたかを全部残す (重なりは、そうと分かるように)
            let note = if duplicate {
                "（ほかのポートと同じ。1 回として扱う）"
            } else {
                ""
            };
            let _ = lines.send(format!("{port}: {}{note}", midi::describe(message)));
        }
    })?;
    let opened = if names.is_empty() {
        "開いたポート: 無し (MIDI の入力ポートが 1 つも見つかりません)".to_string()
    } else {
        format!("開いたポート: {}", names.join(" / "))
    };
    note_activity(&app, "midi-in", &opened);
    Ok(names)
}

/// つながっている MIDI の入力ポートの名前を返す (開かない)。
///
/// 画面は、起動したときにこれを見て、鍵盤がつながっているのに MIDI 入力を始めていなければ知らせる
/// (`web-ui/src/lib/useMidiInput.ts`)。
///
/// 起動してすぐ呼ばれる。OS の MIDI の用意に時間がかかっても窓を止めないよう、メインスレッドでは動かさない。
#[tauri::command(async)]
fn midi_ports() -> Vec<String> {
    midi::port_names()
}

/// MIDI 入力を閉じる。
#[tauri::command]
fn midi_stop(app: tauri::AppHandle, inputs: State<'_, midi::MidiInputs>) {
    inputs.stop();
    note_activity(&app, "midi-in", "ポートを閉じました");
}

/// アプリを起動する (終了するまで戻らない)。
pub fn run() {
    let builder = tauri::Builder::default();
    // テスト用のビルドだけ、窓を外から操作する WebDriver サーバを入れる (配布物には入らない)
    #[cfg(all(feature = "e2e", debug_assertions))]
    let builder = builder.plugin(e2e::webdriver_plugin());
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = LaunchConfig::for_app(app.handle());
            let data_dir = config.as_ref().ok().map(LaunchConfig::data_dir);
            app.manage(activity::ActivityLog::open(
                data_dir.as_deref(),
                &app.package_info().version.to_string(),
            ));
            app.manage(project::ProjectFiles::new(data_dir.clone()));
            app.manage(Sidecar::spawn(config));
            app.manage(midi::MidiInputs::default());
            // 出力デバイスは、画面が audio_init を呼ぶまで開かない
            app.manage(audio::AudioState::new(app.handle().clone(), data_dir));
            windows::create_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            boot_status,
            restart_backend,
            save_api_key,
            delete_api_key,
            midi_start,
            midi_stop,
            midi_ports,
            activity_record,
            activity_info,
            audio::audio_init,
            audio::audio_prepare_piano,
            audio::audio_prepare_instrument,
            audio::audio_render_song,
            audio::audio_clip_put,
            audio::audio_clip_drop,
            audio::audio_set_song,
            audio::audio_play,
            audio::audio_stop,
            audio::audio_set_track,
            audio::audio_set_metronome,
            audio::audio_live_note,
            audio::audio_live_all_off,
            project::project_pick_save,
            project::project_pick_open,
            project::project_commit,
            project::project_open_recent,
            project::recent_projects,
            project::recent_project_remove,
            project::document_state,
            project::close_confirmed
        ])
        .on_window_event(|window, event| match event {
            // 保存していない変更が在るときは、窓を閉じる前に画面に尋ねさせる
            WindowEvent::CloseRequested { api, .. } => {
                project::on_close_requested(window, api);
            }
            // メインの窓 (か、再生を頼んだ窓) が無くなったら、音を止める。ほかの窓 (ツール・使い方) が
            // 開いたままだとアプリは終わらず、下の RunEvent::Exit の片付けが走らないため
            WindowEvent::Destroyed => {
                if let Some(audio) = window.try_state::<audio::AudioState>() {
                    let label = window.label();
                    audio.window_destroyed(label, label == windows::MAIN_LABEL);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Tauri アプリの初期化に失敗しました");

    app.run(|app_handle, event| match event {
        // 利用者が終えようとした (⌘Q。code が None)。保存していない変更が在れば止めて、画面に尋ねさせる
        RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            if project::on_exit_requested(app_handle) {
                api.prevent_exit();
            }
        }
        // 終了時に sidecar を止める。ここを通らない終わり方 (強制終了など) をしても、
        // sidecar は標準入力のパイプが閉じたことで自分から終わる (backend/run_web.py)。
        RunEvent::Exit => {
            // 音声スレッドと、位置を送るスレッドを止める
            if let Some(audio) = app_handle.try_state::<audio::AudioState>() {
                audio.shutdown();
            }
            if let Some(sidecar) = app_handle.try_state::<Sidecar>() {
                sidecar.stop();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    fn read(path: &str) -> String {
        let full = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
        std::fs::read_to_string(&full)
            .unwrap_or_else(|e| panic!("{} を読めません: {e}", full.display()))
    }

    /// 窓を自動操作する WebDriver サーバ (機能 e2e) が、配布物の設定で有効にならないことを確かめる。
    ///
    /// release ビルドで有効にすると compile_error! で止まるが、ここでは「既定で入る」「tauri build が
    /// 勝手に付ける」「権限に紛れ込む」という、設定ファイルの書き換えによる混入を先に止める。
    #[test]
    fn 配布物の設定では_webdriverの機能が有効にならない() {
        let cargo = read("Cargo.toml");
        // [features] の default に e2e を入れない
        let default = cargo
            .lines()
            .find(|line| line.trim_start().starts_with("default"))
            .expect("Cargo.toml に [features] の default が在りません");
        assert!(
            !default.contains("e2e"),
            "default に e2e が入っています: {default}"
        );
        // プラグインは optional (機能 e2e のときだけ入る)
        let plugin = cargo
            .lines()
            .find(|line| line.starts_with("tauri-plugin-wdio-webdriver"))
            .expect("Cargo.toml に tauri-plugin-wdio-webdriver が在りません");
        assert!(
            plugin.contains("optional = true"),
            "optional ではありません: {plugin}"
        );
        // ほかの依存から機能 e2e を有効にしない (e2e を有効にするのは [features] の e2e の行だけ)
        for line in cargo
            .lines()
            .filter(|l| l.contains("dep:tauri-plugin-wdio-webdriver"))
        {
            assert!(
                line.trim_start().starts_with("e2e ="),
                "e2e 以外から有効にしています: {line}"
            );
        }

        // tauri build に機能を足す設定 (build.features) に e2e を入れない。mac 用の設定ファイルも見る
        for name in ["tauri.conf.json", "tauri.macos.conf.json"] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let config: serde_json::Value = serde_json::from_str(&text).unwrap();
            let features = config["build"]["features"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert!(
                features.iter().all(|f| f.as_str() != Some("e2e")),
                "{name} の build.features に e2e が入っています"
            );
        }

        // 窓の権限に、WebDriver のプラグインの権限を足さない (足すと機能 e2e 無しではビルドできなくなる)
        let capabilities = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in std::fs::read_dir(capabilities).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            assert!(
                !text.contains("wdio"),
                "権限に WebDriver のプラグインが入っています"
            );
        }
    }
}
