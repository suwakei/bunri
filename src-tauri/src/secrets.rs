//! API キーの保存先 (OS のキーチェーン)。
//!
//! Claude の API キーは配布物に同梱できないので、利用者が設定画面で入れる。
//! 入れたキーは OS の安全な保存先 (mac ではキーチェーン) に置き、次回の起動時に
//! sidecar へ環境変数で渡す。ファイルには書かない。画面にも返さない。

use keyring::Entry;

/// キーチェーン上の項目名 (アカウント欄)。
const ACCOUNT: &str = "anthropic-api-key";

/// 受け付けるキーの最大の長さ。貼り付け間違い (巨大なテキスト) を保存しないための上限。
const MAX_KEY_LEN: usize = 512;

/// 入力されたキーを整えて確かめる。前後の空白は落とす。
///
/// 空、長すぎる、制御文字 (改行など) を含むものは受け付けない。
pub fn normalize(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API キーが空です".into());
    }
    if key.len() > MAX_KEY_LEN || key.chars().any(char::is_control) {
        return Err("API キーの形式が正しくありません".into());
    }
    Ok(key)
}

fn entry(service: &str) -> Result<Entry, String> {
    Entry::new(service, ACCOUNT).map_err(|e| format!("キーチェーンを使えません: {e}"))
}

/// 保存してある API キーを読む。保存されていなければ `None`。
pub fn load(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("キーチェーンから読めません: {e}")),
    }
}

/// API キーを保存する (すでに在れば置き換える)。
pub fn save(service: &str, key: &str) -> Result<(), String> {
    let key = normalize(key)?;
    entry(service)?
        .set_password(key)
        .map_err(|e| format!("キーチェーンに保存できません: {e}"))
}

/// 保存してある API キーを消す。もともと無くても成功とする。
pub fn delete(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("キーチェーンから消せません: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn キーは前後の空白を落として受け付ける() {
        assert_eq!(normalize("  sk-ant-abc \n"), Ok("sk-ant-abc"));
    }

    #[test]
    fn 空や制御文字を含むキーは受け付けない() {
        assert!(normalize("").is_err());
        assert!(normalize("   \n").is_err());
        assert!(normalize("sk-ant\nabc").is_err());
        assert!(normalize("sk-ant\u{0}abc").is_err());
        assert!(normalize(&"x".repeat(MAX_KEY_LEN + 1)).is_err());
    }

    /// 本物のキーチェーンで、保存 → 読み出し → 削除が通ることを確かめる。
    ///
    /// 利用者のキーチェーンに触るので、普段のテストでは走らせない
    /// (`cargo test -- --ignored キーチェーン` で手で走らせる)。本番とは別の項目名を使う。
    #[test]
    #[ignore = "本物のキーチェーンに書き込む"]
    fn キーチェーンに保存して読み出して消せる() {
        let service = "io.github.suwakei.bunri.test";
        delete(service).unwrap();
        assert_eq!(load(service).unwrap(), None);

        save(service, "  sk-ant-test-1  ").unwrap();
        assert_eq!(load(service).unwrap().as_deref(), Some("sk-ant-test-1"));
        // 上書きできる
        save(service, "sk-ant-test-2").unwrap();
        assert_eq!(load(service).unwrap().as_deref(), Some("sk-ant-test-2"));

        delete(service).unwrap();
        assert_eq!(load(service).unwrap(), None);
        // もともと無くても失敗しない
        delete(service).unwrap();
    }
}
