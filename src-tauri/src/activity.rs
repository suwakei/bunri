//! 動きの記録。アプリの中でいま何が起きたかを、起きた順に 1 行ずつファイルに残す。
//!
//! 利用者が見るための記録で、同じものを Claude Code などのエージェントも読む
//! (利用者が「こう操作したらこうなった」と伝えるとき、エージェントが窓を操作して結果を確かめるとき)。
//! 画面ではステータスバーの「記録」で見られる (`web-ui/src/components/ActivityPanel.tsx`)。
//!
//! - 置き場は、データ置き場の `logs/activity.log`。開発時 (`make desktop`) はリポジトリの `logs/`、
//!   配布物はアプリのデータ置き場の `data/logs/`、窓を自動操作するテストは一時ディレクトリの中
//!   (利用者の記録に混ざらない)
//! - 行の形は `時:分:秒.ミリ秒 [札] 文`。札は、どこで起きたか:
//!   `app` (起動)、`click` `change` `key` (画面の操作)、`status` (ステータスバーの文)、`api` (処理を担当する部分の呼び出し)、
//!   `midi` (MIDI 入力のつなぎ・ノート)、`midi-in` (鍵盤から届いたメッセージ。ポートの名前つき)、
//!   `error` (捕まえられなかった例外)、`agent` (エージェントが行った操作)
//! - 画面で起きたことは、画面がコマンド `activity_record` で 1 行ずつ送ってくる (`web-ui/src/lib/activity.ts`)。
//!   ネイティブ側で起きたこと (MIDI) と、エージェントが外から足した行は、イベント `activity` で画面にも渡す
//! - 入力欄に打っている途中の文字、API キー、sidecar のトークン、API に送った中身は記録しない
//!   (画面側が、載せないものを決めている)。プロジェクト・トラック・ファイルの名前は、結果の文やボタンの名前として載る
//! - 大きくなりすぎないよう、決まった大きさを超えたら `activity.1.log` に回す (1 世代だけ残す)

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// ネイティブ側で起きたことを、画面に渡すイベントの名前。
pub const EVENT: &str = "activity";

/// 記録のファイルの名前 (データ置き場の `logs/` の中)。
const FILE_NAME: &str = "activity.log";
/// 回したあとの、1 つ前の記録の名前。
const PREVIOUS_NAME: &str = "activity.1.log";
/// 起動したときに、これより大きければ回す (バイト)。
const ROTATE_AT_START: u64 = 1024 * 1024;
/// 動いているあいだに、これより大きくなったら回す (バイト)。
const ROTATE_WHILE_RUNNING: u64 = 4 * 1024 * 1024;

/// 1 行の文の長さの上限 (文字数)。超えたぶんは切る。
const MAX_MESSAGE_CHARS: usize = 400;
/// 札の長さの上限 (文字数)。
const MAX_TAG_CHARS: usize = 16;

/// 画面に渡す 1 行 (イベント `activity` の中身)。時刻は、画面が受け取ったときに付ける。
#[derive(Clone, Serialize)]
pub struct Entry {
    pub tag: String,
    pub message: String,
}

/// 開いている記録のファイル。
struct Writer {
    file: File,
    /// いまのファイルの大きさ (バイト)。
    size: u64,
}

/// 動きの記録。Tauri の state として管理する。
pub struct ActivityLog {
    /// 記録のファイルの場所。置き場が分からなかった・作れなかったときは `None` (記録しない)。
    path: Option<PathBuf>,
    writer: Mutex<Option<Writer>>,
}

impl ActivityLog {
    /// データ置き場の `logs/` に記録のファイルを開き、起動の行を書く。
    ///
    /// 置き場が分からない (`None`)、作れない、開けないときは、記録しないだけで失敗にはしない
    /// (記録は、アプリの本来の動きを止めてはいけない)。
    pub fn open(data_dir: Option<&Path>, version: &str) -> Self {
        let Some(dir) = data_dir.map(|d| d.join("logs")) else {
            return Self::disabled();
        };
        let path = dir.join(FILE_NAME);
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("[activity] 記録の置き場を作れません: {e}");
            return Self::disabled();
        }
        if fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE_AT_START) {
            let _ = fs::rename(&path, dir.join(PREVIOUS_NAME));
        }
        let log = match open_append(&path) {
            Ok(writer) => Self {
                path: Some(path),
                writer: Mutex::new(Some(writer)),
            },
            Err(e) => {
                eprintln!("[activity] 記録のファイルを開けません: {e}");
                return Self::disabled();
            }
        };
        let (date, _) = local_date_time(SystemTime::now());
        log.record(
            "app",
            &format!("==== {date} bunri を起動しました (版 {version}) ===="),
        );
        log
    }

    /// 記録しない (置き場が無いとき)。
    fn disabled() -> Self {
        Self {
            path: None,
            writer: Mutex::new(None),
        }
    }

    /// 記録のファイルの場所 (記録していなければ `None`)。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 1 行を記録し、整えた札と文を返す (画面に渡すときに使う)。
    ///
    /// 書けなくても失敗にはしない。
    pub fn record(&self, tag: &str, message: &str) -> Entry {
        let entry = clean(tag, message);
        let Some(path) = &self.path else {
            return entry;
        };
        let (_, time) = local_date_time(SystemTime::now());
        let line = format!("{time} [{}] {}\n", entry.tag, entry.message);
        let mut guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if guard
            .as_ref()
            .is_some_and(|w| w.size > ROTATE_WHILE_RUNNING)
        {
            // いまのファイルを閉じてから回す
            *guard = None;
            let moved = path
                .parent()
                .is_some_and(|dir| fs::rename(path, dir.join(PREVIOUS_NAME)).is_ok());
            // 回せなかったときは、同じファイルを空にして続ける (伸ばし続けない。1 行ごとに回そうとし直さない)
            *guard = if moved {
                open_append(path).ok()
            } else {
                open_emptied(path).ok()
            };
        }
        if let Some(writer) = guard.as_mut() {
            if writer.file.write_all(line.as_bytes()).is_ok() {
                writer.size += line.len() as u64;
            }
        }
        entry
    }
}

/// 記録のファイルを、追記で開く。
fn open_append(path: &Path) -> std::io::Result<Writer> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(Writer { file, size })
}

/// 記録のファイルを、空にして開く (回し替えに失敗したとき)。
fn open_emptied(path: &Path) -> std::io::Result<Writer> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    Ok(Writer { file, size: 0 })
}

/// 札と文を、記録に載せられる形に整える。
///
/// 画面から来た文字列をそのまま書かない。札は英小文字・数字・ハイフンだけにし、文の改行などの
/// 制御文字は空白にして (1 つの記録が必ず 1 行に収まるように)、長すぎる文は切る。
pub fn clean(tag: &str, message: &str) -> Entry {
    let tag: String = tag
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .take(MAX_TAG_CHARS)
        .collect();
    let mut text: String = message
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if message.chars().count() > MAX_MESSAGE_CHARS {
        text.push('…');
    }
    Entry {
        tag: if tag.is_empty() { "ui".into() } else { tag },
        message: text,
    }
}

/// 時刻を、その PC の時間帯での「年-月-日」と「時:分:秒.ミリ秒」にする。
fn local_date_time(now: SystemTime) -> (String, String) {
    let since_epoch = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (year, month, day, hour, minute, second) = local_fields(since_epoch.as_secs());
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!(
            "{hour:02}:{minute:02}:{second:02}.{:03}",
            since_epoch.subsec_millis()
        ),
    )
}

/// 秒 (1970 年からの経過) を、その PC の時間帯での年月日・時分秒にする。
#[cfg(unix)]
fn local_fields(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let time = secs as libc::time_t;
    // SAFETY: `localtime_r` は、渡した `tm` に結果を書くだけで、ほかのスレッドと共有する状態を返さない。
    // `tm` はゼロで初期化した自分の領域で、ポインタはどちらも呼び出しのあいだ有効。
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&time, &mut tm).is_null() {
            return utc_fields(secs);
        }
        tm
    };
    (
        tm.tm_year + 1900,
        (tm.tm_mon + 1) as u32,
        tm.tm_mday as u32,
        tm.tm_hour as u32,
        tm.tm_min as u32,
        tm.tm_sec as u32,
    )
}

/// 時間帯を OS に聞けない環境では、協定世界時のまま出す。
#[cfg(not(unix))]
fn local_fields(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    utc_fields(secs)
}

/// 秒 (1970 年からの経過) を、協定世界時の年月日・時分秒にする。
fn utc_fields(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rest = (secs % 86_400) as u32;
    // 日数から年月日へ (Howard Hinnant の days_from_civil の逆。グレゴリオ暦)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    (year, month, day, rest / 3_600, rest % 3_600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テストごとの一時ディレクトリ (終わったら消す)。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bunri-activity-{label}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 札と文を整える() {
        let entry = clean("status", "準備完了");
        assert_eq!(
            (entry.tag.as_str(), entry.message.as_str()),
            ("status", "準備完了")
        );
    }

    #[test]
    fn 改行は空白にして1行に収める() {
        let entry = clean("error", "1 行目\n[api] 偽の行\r\t続き");
        assert_eq!(entry.message, "1 行目 [api] 偽の行  続き");
    }

    #[test]
    fn 札に使えない文字は落とし_空なら_ui_にする() {
        assert_eq!(clean("MIDI in] [x", "a").tag, "inx");
        assert_eq!(clean("]\n[", "a").tag, "ui");
        assert_eq!(
            clean("abcdefghijklmnopqrstuvwxyz", "a").tag,
            "abcdefghijklmnop"
        );
        assert_eq!(clean("midi-in", "a").tag, "midi-in");
    }

    #[test]
    fn 長すぎる文は切って印を付ける() {
        let long = "あ".repeat(MAX_MESSAGE_CHARS + 10);
        let message = clean("api", &long).message;
        assert_eq!(message.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(message.ends_with('…'));
        // ちょうど上限なら、印は付けない
        let exact = "a".repeat(MAX_MESSAGE_CHARS);
        assert_eq!(clean("api", &exact).message, exact);
    }

    #[test]
    fn 起動の行と記録した行が_時刻つきでファイルに並ぶ() {
        let dir = TempDir::new("write");
        let log = ActivityLog::open(Some(&dir.0), "1.2.3");
        log.record("click", "ボタン「再生」");
        log.record("status", "再生中");

        let path = dir.0.join("logs").join("activity.log");
        assert_eq!(log.path(), Some(path.as_path()));
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert!(
            lines[0].contains("[app] ==== ")
                && lines[0].contains("bunri を起動しました (版 1.2.3) ===="),
            "{}",
            lines[0]
        );
        assert!(
            lines[1].ends_with(" [click] ボタン「再生」"),
            "{}",
            lines[1]
        );
        assert!(lines[2].ends_with(" [status] 再生中"), "{}", lines[2]);
        // 行の頭は「時:分:秒.ミリ秒」
        for line in &lines {
            let time = line.split(' ').next().unwrap();
            let bytes = time.as_bytes();
            assert_eq!(time.len(), 12, "{line}");
            assert!(
                bytes[2] == b':' && bytes[5] == b':' && bytes[8] == b'.',
                "{line}"
            );
        }
    }

    #[test]
    fn 開き直すと_前の記録の後ろに続ける() {
        let dir = TempDir::new("append");
        ActivityLog::open(Some(&dir.0), "1").record("status", "1 回目");
        ActivityLog::open(Some(&dir.0), "1").record("status", "2 回目");
        let text = fs::read_to_string(dir.0.join("logs").join("activity.log")).unwrap();
        assert_eq!(text.lines().count(), 4, "{text}");
        assert!(text.contains("1 回目") && text.contains("2 回目"));
    }

    #[test]
    fn 起動のときに大きすぎる記録は_1つ前の名前に回す() {
        let dir = TempDir::new("rotate");
        let logs = dir.0.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            logs.join("activity.log"),
            vec![b'x'; (ROTATE_AT_START + 1) as usize],
        )
        .unwrap();

        let log = ActivityLog::open(Some(&dir.0), "1");
        log.record("status", "新しい記録");
        assert_eq!(
            fs::metadata(logs.join("activity.1.log")).unwrap().len(),
            ROTATE_AT_START + 1
        );
        let text = fs::read_to_string(logs.join("activity.log")).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
    }

    #[test]
    fn 動いているあいだに大きくなりすぎたら回す() {
        let dir = TempDir::new("rotate-running");
        let log = ActivityLog::open(Some(&dir.0), "1");
        log.writer.lock().unwrap().as_mut().unwrap().size = ROTATE_WHILE_RUNNING + 1;
        log.record("status", "回したあとの行");

        let logs = dir.0.join("logs");
        assert!(fs::read_to_string(logs.join("activity.1.log"))
            .unwrap()
            .contains("bunri を起動しました"));
        let text = fs::read_to_string(logs.join("activity.log")).unwrap();
        assert_eq!(text.lines().count(), 1, "{text}");
        assert!(text.contains("回したあとの行"));
    }

    #[test]
    fn 回せなかったときは_空にして続ける() {
        let dir = TempDir::new("rotate-fail");
        let log = ActivityLog::open(Some(&dir.0), "1");
        // 1 つ前の名前の場所に、空でないディレクトリを置いて、回し替えを失敗させる
        let logs = dir.0.join("logs");
        fs::create_dir_all(logs.join("activity.1.log").join("x")).unwrap();
        log.writer.lock().unwrap().as_mut().unwrap().size = ROTATE_WHILE_RUNNING + 1;
        log.record("status", "1 行目");
        log.record("status", "2 行目");

        let text = fs::read_to_string(logs.join("activity.log")).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.contains("1 行目") && text.contains("2 行目"));
    }

    #[test]
    fn 置き場が無ければ_記録せずに整えた行だけ返す() {
        let log = ActivityLog::open(None, "1");
        assert_eq!(log.path(), None);
        assert_eq!(log.record("status", "a\nb").message, "a b");
    }

    #[test]
    fn 協定世界時の年月日を正しく出す() {
        assert_eq!(utc_fields(0), (1970, 1, 1, 0, 0, 0));
        // 2026-11-18 12:34:56 UTC
        assert_eq!(utc_fields(1_795_005_296), (2026, 11, 18, 12, 34, 56));
        // うるう日 2024-02-29 23:59:59 UTC
        assert_eq!(utc_fields(1_709_251_199), (2024, 2, 29, 23, 59, 59));
    }
}
