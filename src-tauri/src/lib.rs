//! bunri DAW のデスクトップアプリ (ネイティブ側)。
//!
//! 役割は 3 つだけ。
//!
//! - 画面 (web-ui の React) を表示する窓を開く
//! - Python sidecar (今までの FastAPI) を起動し、見張り、アプリと一緒に終わらせる。
//!   配布物では、その前に Python 環境を用意する (初回セットアップ)
//! - sidecar のポートとトークンを画面に渡す
//!
//! AI・音声処理は Python、画面は Web のまま。ここには書き直さない。
//!
//! 将来、再生・録音・MIDI 入力を低レイテンシにするための音声エンジン (cpal / midir) は
//! このクレートに `mod audio;` として足し、`invoke_handler` にコマンドを並べる想定。

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
    secrets::save(&app.config().identifier, &key)
}

/// キーチェーンに保存した Claude の API キーを消す。
#[tauri::command]
fn delete_api_key(app: tauri::AppHandle) -> Result<(), String> {
    secrets::delete(&app.config().identifier)
}

/// アプリを起動する (終了するまで戻らない)。
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let config = LaunchConfig::for_app(app.handle());
            app.manage(Sidecar::spawn(config));
            windows::create_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            boot_status,
            save_api_key,
            delete_api_key
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
