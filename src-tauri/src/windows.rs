//! 窓の生成。
//!
//! メインの窓に加えて、画面の `<a target="_blank">` (ヘッダの「ツール」「使い方」) を
//! 別の窓として開けるようにする。ブラウザ版ではこれらは別タブで開き、作業中の DAW の状態を
//! 保ったままツールを使える。WebView は何もしないと新しい窓の要求を黙って捨てるので、
//! ここで受けて窓を作る。
//!
//! どの窓でも、画面の書き出し (`<a download>`。WAV・MIDI の書き出しなど) を Rust で受けて保存する。

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse};
use tauri::{App, AppHandle, Url, Webview, WebviewUrl, WebviewWindowBuilder};

/// メインの窓のラベル (tauri.conf.json の `app.windows[].label` と合わせる)。
pub(crate) const MAIN_LABEL: &str = "main";

/// 追加で開いた窓のラベルに付ける連番。
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// メインの窓を、tauri.conf.json の設定から作る。
///
/// 新しい窓の要求を受けるハンドラを付けるため、設定側は `"create": false` にして
/// ここで作っている。
pub fn create_main_window(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .expect("tauri.conf.json に main の窓の設定が在りません");
    let handle = app.handle().clone();
    let builder = WebviewWindowBuilder::from_config(app.handle(), config)?
        .on_new_window(move |url, features| open_window(&handle, &url, features))
        .on_download(on_download);
    // 窓を自動操作するテストのビルドだけ、保存領域を使い捨てにし、CSP の違反などを記録する
    #[cfg(feature = "e2e")]
    let builder = crate::e2e::configure_main_window(builder);
    builder.build()?;
    Ok(())
}

/// 画面からの「新しい窓を開く」要求に応える。
///
/// アプリ自身のページ (`/tools` `/help` など) だけを窓として開く。
/// 外部の URL は開かない。
fn open_window(
    app: &AppHandle,
    url: &Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if !is_app_url(app, url) {
        eprintln!("[window] アプリ外の URL は開きません: {url}");
        return NewWindowResponse::Deny;
    }
    let label = format!("window-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    // 中身は WebView が要求された URL を読み込む。ここでは空のページで窓だけ用意する
    let blank = WebviewUrl::External("about:blank".parse().expect("about:blank は正しい URL"));
    let built = WebviewWindowBuilder::new(app, label, blank)
        .window_features(features)
        .title("bunri")
        .inner_size(1200.0, 800.0)
        .on_download(on_download)
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(e) => {
            eprintln!("[window] 窓を作れませんでした: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// 画面からのダウンロード (書き出し) を受けて、保存を許す。
///
/// 保存先は WebView (wry) が決める既定のまま: 利用者のダウンロードフォルダ (`~/Downloads`) に、
/// 画面が付けた名前で置く。同じ名前のファイルが在れば上書きせず、`名前 (1).wav` のように番号を付ける。
///
/// 受け手が無くても WKWebView は `~/Downloads` に保存する (実測) が、ここで受けておくと、
/// 保存したかどうかがログに残り、窓を自動操作するテストが保存先を一時ディレクトリに差し替えられる
/// (テストと配布物が、同じ保存の経路を通る)。
fn on_download<R: tauri::Runtime>(_webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            // テスト用のビルドでは、保存先をテストが指定した一時ディレクトリにする
            #[cfg(feature = "e2e")]
            crate::e2e::redirect_download(destination);
            eprintln!(
                "[download] {} を保存します: {}",
                url.scheme(),
                destination.display()
            );
        }
        DownloadEvent::Finished { path, success, .. } => {
            let path = path.map(|p| p.display().to_string()).unwrap_or_default();
            if success {
                eprintln!("[download] 保存しました: {path}");
            } else {
                eprintln!("[download] 保存できませんでした: {path}");
            }
        }
        _ => {}
    }
    true
}

/// アプリ自身のページの URL か。
///
/// 配布物では `tauri://localhost`、`tauri dev` では開発サーバの origin が該当する。
fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    is_app_origin(url, dev_url)
}

/// `url` の origin が、アプリの画面のもの (`tauri://localhost` か `dev_url` と同じ) か。
fn is_app_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    dev_url.is_some_and(|dev| {
        url.scheme() == dev.scheme()
            && url.host_str() == dev.host_str()
            && url.port_or_known_default() == dev.port_or_known_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn アプリ自身のページは開ける() {
        let dev = url("http://localhost:3000");
        assert!(is_app_origin(&url("tauri://localhost/tools"), None));
        assert!(is_app_origin(
            &url("tauri://localhost/help#synth"),
            Some(&dev)
        ));
        assert!(is_app_origin(
            &url("http://localhost:3000/tools"),
            Some(&dev)
        ));
    }

    #[test]
    fn 外部のurlは開かない() {
        let dev = url("http://localhost:3000");
        assert!(!is_app_origin(&url("https://example.com/"), Some(&dev)));
        assert!(!is_app_origin(
            &url("http://localhost:3001/tools"),
            Some(&dev)
        ));
        assert!(!is_app_origin(
            &url("http://localhost.evil.example:3000/"),
            Some(&dev)
        ));
        assert!(!is_app_origin(&url("tauri://evil/tools"), Some(&dev)));
        // 開発サーバの origin は、配布物 (dev_url なし) では許さない
        assert!(!is_app_origin(&url("http://localhost:3000/tools"), None));
        // sidecar の API を窓として開くこともしない
        assert!(!is_app_origin(
            &url("http://127.0.0.1:54321/api/download/a.wav"),
            Some(&dev)
        ));
    }
}
