//! Python sidecar (backend/run_web.py --sidecar) の起動・監視・終了。
//!
//! 約束ごと (Python 側は backend/run_web.py と backend/access_control.py):
//!
//! - **ポートは Python 側が決める。** `--sidecar` で起動すると空きポートで待ち受け、
//!   標準出力の最初の行に `{"event": "listening", "port": N, "pid": P}` を出す。
//!   こちらが空きポートを選んで渡すと、起動までの間に他のプロセスに取られることがある。
//! - **API には鍵をかける。** 起動ごとに乱数のトークンを作り、環境変数 `BUNRI_TOKEN` で渡す
//!   (引数だと `ps` で見えるため)。画面は全リクエストにそのトークンを付ける。
//! - **sidecar を孤児にしない。** sidecar の標準入力をパイプで握ったままにする。
//!   アプリが終了しても異常終了しても、OS がパイプを閉じるので、sidecar は EOF を見て自分で終わる。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::watch;

/// 画面に渡す接続情報。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BackendInfo {
    /// sidecar が待ち受けているポート (127.0.0.1)。
    pub port: u16,
    /// API の鍵。全リクエストのヘッダ `X-Bunri-Token` に付ける。
    pub token: String,
}

/// sidecar の状態。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Status {
    /// 起動して、ポートの知らせを待っている。
    Starting,
    /// 待ち受け中。
    Ready(BackendInfo),
    /// 起動できなかった、または終了した。理由つき。
    Failed(String),
}

/// sidecar の起動に要る設定。
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    /// 起動するプログラム (開発時は `uv`)。
    pub program: PathBuf,
    /// プログラムに渡す引数。
    pub args: Vec<String>,
    /// 起動するときの作業ディレクトリ (リポジトリの直下)。
    pub cwd: PathBuf,
    /// API を呼んでよい origin (CORS の許可先)。
    pub allowed_origins: Vec<String>,
}

impl LaunchConfig {
    /// アプリの設定から、sidecar の起動方法を決める。
    ///
    /// いまは開発機の `uv run` で起動する (リポジトリの `uv.lock` どおりの環境で動く)。
    /// 配布物では、同梱した `uv` とアプリのデータ置き場に作った Python 環境を使うよう、
    /// この関数を差し替える。
    ///
    /// 環境変数 `BUNRI_UV` で `uv` の場所を、`BUNRI_REPO_ROOT` でリポジトリの場所を上書きできる。
    pub fn for_app(app: &AppHandle) -> Self {
        let repo_root = std::env::var_os("BUNRI_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                // src-tauri/ の親 = リポジトリの直下 (ビルドした場所のパス)
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .map(PathBuf::from)
                    .unwrap_or_default()
            });
        let program = std::env::var_os("BUNRI_UV")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("uv"));

        // 画面の origin。配布物では tauri://localhost、`tauri dev` では開発サーバの URL
        let mut allowed_origins = vec!["tauri://localhost".to_string()];
        if cfg!(debug_assertions) {
            if let Some(dev_url) = &app.config().build.dev_url {
                allowed_origins.push(dev_url.origin().ascii_serialization());
            }
        }

        Self {
            program,
            args: [
                "run",
                "--frozen",
                "python",
                "backend/run_web.py",
                "--sidecar",
            ]
            .map(String::from)
            .to_vec(),
            cwd: repo_root,
            allowed_origins,
        }
    }
}

/// 起動した sidecar。Tauri の state として管理する。
pub struct Sidecar {
    status: watch::Receiver<Status>,
    child: Mutex<Option<Child>>,
}

impl Sidecar {
    /// sidecar を起動する。すぐに戻る (待ち受け開始は [`Sidecar::wait_ready`] で待つ)。
    ///
    /// 起動に失敗しても panic せず、状態を「失敗」にする。画面がその理由を表示する。
    pub fn spawn(config: LaunchConfig) -> Self {
        let (tx, rx) = watch::channel(Status::Starting);

        let token = match generate_token() {
            Ok(token) => token,
            Err(reason) => {
                let _ = tx.send(Status::Failed(reason));
                return Self {
                    status: rx,
                    child: Mutex::new(None),
                };
            }
        };

        let spawned = Command::new(&config.program)
            .args(&config.args)
            .current_dir(&config.cwd)
            .env("BUNRI_TOKEN", &token)
            .env("BUNRI_ALLOWED_ORIGINS", config.allowed_origins.join(","))
            // ポートの知らせがバッファに溜まって届かない、ということが無いように
            .env("PYTHONUNBUFFERED", "1")
            // 握ったままにして、親が居なくなったことを sidecar に知らせる手段にする
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();

        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                let _ = tx.send(Status::Failed(format!(
                    "バックエンドを起動できませんでした: {} を実行できません ({e})。作業ディレクトリ: {}",
                    config.program.display(),
                    config.cwd.display(),
                )));
                return Self {
                    status: rx,
                    child: Mutex::new(None),
                };
            }
        };

        // 標準出力を読み続ける。最初の行がポートの知らせ、以降はログ
        if let Some(stdout) = child.stdout.take() {
            thread::Builder::new()
                .name("sidecar-stdout".into())
                .spawn(move || watch_stdout(stdout, token, tx))
                .expect("sidecar の監視スレッドを起動できません");
        }

        Self {
            status: rx,
            child: Mutex::new(Some(child)),
        }
    }

    /// sidecar が待ち受けを始めるまで待ち、接続情報を返す。
    ///
    /// 起動に失敗した、または起動前に終了した場合は、理由を返す。
    pub async fn wait_ready(&self) -> Result<BackendInfo, String> {
        let mut status = self.status.clone();
        let current = status
            .wait_for(|s| *s != Status::Starting)
            .await
            .map_err(|_| "バックエンドの監視が止まりました".to_string())?
            .clone();
        match current {
            Status::Ready(info) => Ok(info),
            Status::Failed(reason) => Err(reason),
            Status::Starting => unreachable!("Starting の間は待ち続ける"),
        }
    }

    /// sidecar を止める。アプリの終了時に呼ぶ。何度呼んでもよい。
    ///
    /// まず標準入力を閉じる (sidecar は EOF を見て、自分と子プロセスを終わらせる)。
    /// 少し待っても終わらなければ kill する。
    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().ok().and_then(|mut guard| guard.take()) else {
            return;
        };
        drop(child.stdin.take());

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                _ => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// sidecar が標準出力の最初の行に出す知らせ。
#[derive(Debug, Deserialize)]
struct Announcement {
    event: String,
    port: u16,
}

/// 標準出力の 1 行を、ポートの知らせとして読む。知らせでなければ None。
fn parse_announcement(line: &str) -> Option<u16> {
    let announcement: Announcement = serde_json::from_str(line.trim()).ok()?;
    (announcement.event == "listening" && announcement.port != 0).then_some(announcement.port)
}

/// sidecar の標準出力を最後まで読む (監視スレッドの本体)。
///
/// ポートの知らせを受け取ったら状態を「待ち受け中」にする。それ以外の行はログとして流す。
/// 標準出力が閉じたら sidecar は終了しているので、状態を「失敗」にする。
fn watch_stdout(stdout: impl std::io::Read, token: String, tx: watch::Sender<Status>) {
    let mut ready = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if !ready {
            if let Some(port) = parse_announcement(&line) {
                ready = true;
                let _ = tx.send(Status::Ready(BackendInfo {
                    port,
                    token: token.clone(),
                }));
                continue;
            }
        }
        eprintln!("[backend] {line}");
    }
    let reason = if ready {
        "バックエンドが終了しました"
    } else {
        "バックエンドが待ち受けを始める前に終了しました。ターミナルに出ているエラーを確認してください"
    };
    let _ = tx.send(Status::Failed(reason.to_string()));
}

/// 起動ごとのトークンを作る (OS の乱数 32 バイトを 16 進数にしたもの)。
fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("トークン用の乱数を取得できません: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 知らせの行からポートを読める() {
        assert_eq!(
            parse_announcement(r#"{"event": "listening", "port": 54321, "pid": 1}"#),
            Some(54321)
        );
        assert_eq!(
            parse_announcement("  {\"event\":\"listening\",\"port\":8000}\n"),
            Some(8000)
        );
    }

    #[test]
    fn 知らせでない行は無視する() {
        assert_eq!(
            parse_announcement("INFO:     Started server process [1]"),
            None
        );
        assert_eq!(parse_announcement(r#"{"event": "other", "port": 1}"#), None);
        assert_eq!(
            parse_announcement(r#"{"event": "listening", "port": 0}"#),
            None
        );
        assert_eq!(parse_announcement(r#"{"event": "listening"}"#), None);
        assert_eq!(parse_announcement(""), None);
    }

    #[test]
    fn トークンは毎回違う64桁の16進数() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn 知らせを受けると待ち受け中になり_出力が閉じると失敗になる() {
        let (tx, rx) = watch::channel(Status::Starting);
        let output = "{\"event\": \"listening\", \"port\": 4000}\nINFO: log line\n";
        watch_stdout(output.as_bytes(), "tok".into(), tx);
        // 最後の状態は「終了した」
        assert_eq!(
            *rx.borrow(),
            Status::Failed("バックエンドが終了しました".into())
        );
    }

    #[test]
    fn 知らせの前に出力が閉じたら起動失敗() {
        let (tx, rx) = watch::channel(Status::Starting);
        watch_stdout(
            "Traceback (most recent call last):\n".as_bytes(),
            "tok".into(),
            tx,
        );
        assert!(
            matches!(&*rx.borrow(), Status::Failed(reason) if reason.contains("待ち受けを始める前"))
        );
    }

    #[test]
    fn 実行できないプログラムなら理由つきで失敗する() {
        let sidecar = Sidecar::spawn(LaunchConfig {
            program: PathBuf::from("/nonexistent/bunri-test-program"),
            args: vec![],
            cwd: std::env::temp_dir(),
            allowed_origins: vec![],
        });
        let status = sidecar.status.borrow().clone();
        assert!(matches!(status, Status::Failed(reason) if reason.contains("実行できません")));
        sidecar.stop();
    }

    /// 本物の子プロセスで、知らせの受け取りと、stop() で終わることを確かめる (POSIX のシェルを使う)。
    #[cfg(unix)]
    #[test]
    fn 子プロセスの知らせを受け取り_stopで終わらせる() {
        // 知らせを出したあと、標準入力が閉じるまで待つだけの「sidecar もどき」
        let script = r#"echo "{\"event\": \"listening\", \"port\": 4321, \"token_seen\": \"$BUNRI_TOKEN\"}"; cat > /dev/null"#;
        let sidecar = Sidecar::spawn(LaunchConfig {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            allowed_origins: vec!["tauri://localhost".into()],
        });
        let mut status = sidecar.status.clone();
        let deadline = Instant::now() + Duration::from_secs(5);
        while *status.borrow_and_update() == Status::Starting && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let info = match status.borrow().clone() {
            Status::Ready(info) => info,
            other => panic!("待ち受け中にならない: {other:?}"),
        };
        assert_eq!(info.port, 4321);
        assert_eq!(info.token.len(), 64);

        let pid = sidecar.child.lock().unwrap().as_ref().unwrap().id();
        let started = Instant::now();
        sidecar.stop();
        // 標準入力を閉じただけで終わるので、kill の待ち時間 (3 秒) より十分早い
        assert!(started.elapsed() < Duration::from_secs(2));
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "stop() のあとも子プロセスが残っている");
    }
}
