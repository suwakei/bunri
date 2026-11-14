//! 窓を自動操作するテスト (`make e2e-desktop`) のためだけの仕掛け。機能 `e2e` のときだけ入る。
//!
//! - WebDriver サーバ (`tauri-plugin-wdio-webdriver`) をアプリの中で起動する。テストはここに
//!   つないで、本物の窓 (WKWebView) を操作する。ポートは環境変数 `TAURI_WEBDRIVER_PORT`
//! - 利用者のデータに触れないようにする: WebView の保存領域 (localStorage など) は使い捨てにし、
//!   キーチェーンは本番とは別の項目名にし、書き出したファイルはテストが指定した場所に保存する
//! - プロジェクトの保存・開くのダイアログは出さず、テストが環境変数で渡した場所を使う
//! - 画面の外から確かめにくいこと (CSP の違反、捕まえられなかった例外) を記録しておき、
//!   テストが `window.__bunriE2E` で読めるようにする
//!
//! **配布物には絶対に入れない。** WebDriver サーバには認証が無く、同じ PC のプロセスなら誰でも
//! 窓を操作し、任意の JavaScript を実行できる (= sidecar のトークンも読める)。
//! release ビルドでこの機能を有効にすると、lib.rs の `compile_error!` でビルドが止まる。

use std::path::PathBuf;

use tauri::{Runtime, WebviewWindowBuilder};

/// 書き出したファイルの保存先を差し替える環境変数 (テストが一時ディレクトリを渡す)。
pub const DOWNLOAD_DIR_ENV: &str = "BUNRI_E2E_DOWNLOAD_DIR";

/// プロジェクトの保存のダイアログの代わりに使う場所 (テストが一時ディレクトリの中を渡す)。
///
/// WebDriver はネイティブのダイアログ (NSSavePanel) を操作できない。テスト用のビルドだけ、
/// ダイアログを出さずにこの場所が選ばれたことにする (`project.rs` の `pick_save_path`)。
pub const SAVE_PATH_ENV: &str = "BUNRI_E2E_SAVE_PATH";
/// プロジェクトを開くダイアログの代わりに使う場所。
pub const OPEN_PATH_ENV: &str = "BUNRI_E2E_OPEN_PATH";

/// 音を出さないようにする環境変数 (`1` のとき)。ネイティブの engine が作った音に 0 を掛けてから
/// デバイスへ渡す (`audio.rs`)。テストを回している機械のスピーカーから音を出したくないときに使う。
/// 出力デバイスを開くところから位置を送るところまでは、配布物と同じに動く。
pub const AUDIO_SILENT_ENV: &str = "BUNRI_E2E_AUDIO_SILENT";

/// 音を出さないようにするか。
pub fn audio_silent() -> bool {
    std::env::var_os(AUDIO_SILENT_ENV).is_some_and(|value| value == "1")
}

/// ダイアログの代わりに使う場所を、環境変数から読む (無ければ None で、本物のダイアログを出す)。
pub fn dialog_path(env: &str) -> Option<PathBuf> {
    std::env::var_os(env)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// 画面の読み込みより前に入れるスクリプト。CSP の違反と、捕まえられなかった例外を記録する。
///
/// ページの読み込み中に起きた違反も拾えるよう、テストがつなぐ前 (WebView の初期化時) に入れる。
/// WebView が直接入れるので、このスクリプト自体は CSP の対象にならない。
const RECORDER_SCRIPT: &str = r#"
(() => {
  const log = { csp: [], errors: [] };
  Object.defineProperty(window, '__bunriE2E', { value: log });
  document.addEventListener('securitypolicyviolation', (e) => {
    log.csp.push({
      directive: e.violatedDirective || e.effectiveDirective,
      blocked: e.blockedURI,
      source: e.sourceFile,
      line: e.lineNumber,
      sample: e.sample,
    });
  });
  window.addEventListener('error', (e) => {
    log.errors.push(String(e.message || e.error || 'error'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    log.errors.push('unhandledrejection: ' + String((reason && reason.message) || reason));
  });
})();
"#;

/// WebDriver サーバを、アプリの中で起動するプラグイン。
pub fn webdriver_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_wdio_webdriver::init()
}

/// メインの窓に、テスト用の設定を足す。
///
/// - 保存領域を使い捨てにする (incognito)。開発用の `tauri dev` と同じ実行ファイル名なので、
///   そのままだと利用者の開発中のアプリと localStorage を共有してしまう
/// - CSP の違反などを記録するスクリプトを入れる
pub fn configure_main_window<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .incognito(true)
        .initialization_script(RECORDER_SCRIPT)
}

/// キーチェーン上のサービス名。本番の項目 (アプリの識別子) とは別にする。
pub fn keychain_service(identifier: &str) -> String {
    format!("{identifier}.e2e")
}

/// 書き出したファイルの保存先を、テストが指定した場所に差し替える (指定が無ければそのまま)。
pub fn redirect_download(destination: &mut PathBuf) {
    let Some(dir) = std::env::var_os(DOWNLOAD_DIR_ENV) else {
        return;
    };
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    // WebView は、利用者の ~/Downloads に同じ名前が在ると「名前 (1).wav」にしてから知らせてくる。
    // テストが指定した場所では、画面が付けた元の名前に戻す
    *destination = PathBuf::from(dir).join(without_copy_number(&name));
}

/// 「名前 (1).wav」の「 (1)」を落とす。番号が付いていなければそのまま返す。
fn without_copy_number(name: &str) -> String {
    let (stem, ext) = name
        .split_once('.')
        .map_or((name, String::new()), |(stem, ext)| {
            (stem, format!(".{ext}"))
        });
    if let Some(number) = stem
        .strip_suffix(')')
        .and_then(|rest| rest.rsplit_once(" ("))
    {
        let (base, digits) = number;
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return format!("{base}{ext}");
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 重なりを避ける番号だけを落とす() {
        assert_eq!(without_copy_number("bunri_mix (2).wav"), "bunri_mix.wav");
        assert_eq!(without_copy_number("bunri_mix.wav"), "bunri_mix.wav");
        assert_eq!(without_copy_number("take (live).wav"), "take (live).wav");
        assert_eq!(without_copy_number("a () .wav"), "a () .wav");
        assert_eq!(without_copy_number("noext (3)"), "noext");
    }

    #[test]
    fn キーチェーンは本番と別の項目名を使う() {
        assert_eq!(
            keychain_service("io.github.suwakei.bunri"),
            "io.github.suwakei.bunri.e2e"
        );
    }
}
