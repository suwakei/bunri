//! bunri DAW のデスクトップアプリ (ネイティブ側)。
//!
//! 役割は 3 つだけ。
//!
//! - 画面 (web-ui の React) を表示する窓を開く
//! - Python sidecar (今までの FastAPI) を起動し、見張り、アプリと一緒に終わらせる。
//!   配布物では、その前に Python 環境を用意する (初回セットアップ)
//! - sidecar のポートとトークンを画面に渡す
//! - MIDI キーボードの入力を受けて画面に渡す (WebView が Web MIDI を持たないため)
//!
//! AI・音声処理は Python、画面は Web のまま。ここには書き直さない。
//!
//! 将来、再生・録音・MIDI 入力を低レイテンシにするための音声エンジン (cpal / midir) は
//! このクレートに `mod audio;` として足し、`invoke_handler` にコマンドを並べる想定。

// 窓を自動操作するテスト用の仕掛け (WebDriver サーバ) は、配布物に入れてはいけない。
// 開発用のビルド (debug) でしか有効にできないようにする。docs/desktop-architecture.md「窓を自動操作するテスト」
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!(
    "機能 e2e (窓を自動操作する WebDriver サーバ) は release ビルドでは使えません。配布物に入れないでください"
);

#[cfg(feature = "e2e")]
mod e2e;
mod midi;
mod secrets;
mod sidecar;
mod windows;

use sidecar::{BackendInfo, BootStatus, LaunchConfig, Sidecar};
use tauri::{Manager, RunEvent, State};

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

/// MIDI 入力を開く。つながっている入力ポートをすべて開き、開けたポートの名前を返す。
///
/// 受けたメッセージは、イベント `midi-message` で画面に送る (中身はバイト列)。
/// すでに開いていれば開き直すので、機器を挿し直したあとの再検出にも使う。
#[tauri::command]
fn midi_start(
    app: tauri::AppHandle,
    inputs: State<'_, midi::MidiInputs>,
) -> Result<Vec<String>, String> {
    use tauri::Emitter;
    inputs.start(move |message| {
        let _ = app.emit(midi::EVENT, message.to_vec());
    })
}

/// MIDI 入力を閉じる。
#[tauri::command]
fn midi_stop(inputs: State<'_, midi::MidiInputs>) {
    inputs.stop();
}

/// アプリを起動する (終了するまで戻らない)。
pub fn run() {
    let builder = tauri::Builder::default();
    // テスト用のビルドだけ、窓を外から操作する WebDriver サーバを入れる (配布物には入らない)
    #[cfg(all(feature = "e2e", debug_assertions))]
    let builder = builder.plugin(e2e::webdriver_plugin());
    let app = builder
        .setup(|app| {
            let config = LaunchConfig::for_app(app.handle());
            app.manage(Sidecar::spawn(config));
            app.manage(midi::MidiInputs::default());
            windows::create_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            boot_status,
            save_api_key,
            delete_api_key,
            midi_start,
            midi_stop
        ])
        .build(tauri::generate_context!())
        .expect("Tauri アプリの初期化に失敗しました");

    app.run(|app_handle, event| {
        // 終了時に sidecar を止める。ここを通らない終わり方 (強制終了など) をしても、
        // sidecar は標準入力のパイプが閉じたことで自分から終わる (backend/run_web.py)。
        if let RunEvent::Exit = event {
            if let Some(sidecar) = app_handle.try_state::<Sidecar>() {
                sidecar.stop();
            }
        }
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
