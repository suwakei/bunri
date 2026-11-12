//! Python sidecar (backend/run_web.py --sidecar) の準備・起動・監視・終了。
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
//!
//! 配布物では、起動の前に Python 環境を用意する段階 (セットアップ) が入る。
//! 同梱した `uv` で、アプリのデータ置き場に `uv.lock` どおりの環境を作る。
//! `uv sync` は済んだぶんを飛ばすので、途中で落ちても次回の起動で続きから入る。

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

/// 画面に見せるログの行数 (末尾だけ残す)。
const LOG_TAIL: usize = 8;

/// 画面に渡す接続情報。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BackendInfo {
    /// sidecar が待ち受けているポート (127.0.0.1)。
    pub port: u16,
    /// API の鍵。全リクエストのヘッダ `X-Bunri-Token` に付ける。
    pub token: String,
}

/// 起動がどこまで進んだか。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Python 環境を用意している (依存のダウンロードとインストール)。
    Setup,
    /// sidecar を起動して、ポートの知らせを待っている。
    Starting,
    /// 待ち受け中。
    Ready,
    /// 用意か起動に失敗した、または sidecar が終了した。
    Failed,
}

/// 起動の進み具合。画面が起動待ちの間に表示する。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BootStatus {
    /// どの段階か。
    pub phase: Phase,
    /// 利用者に見せる 1 行の説明。失敗のときは理由。
    pub message: String,
    /// 直近のログ (uv の出力など)。進んでいることが分かるように見せる。
    pub log: Vec<String>,
    /// 依存のダウンロードが入るか (初回など。時間がかかることを伝えるため)。
    pub first_run: bool,
    /// 待ち受け中になったときの接続情報。
    #[serde(skip)]
    info: Option<BackendInfo>,
}

impl BootStatus {
    fn new(phase: Phase, message: impl Into<String>) -> Self {
        Self {
            phase,
            message: message.into(),
            log: Vec::new(),
            first_run: false,
            info: None,
        }
    }
}

/// 起動する 1 つのプロセスの指定。
#[derive(Clone, Debug, Default)]
pub struct ProcessSpec {
    /// 起動するプログラム。
    pub program: PathBuf,
    /// プログラムに渡す引数。
    pub args: Vec<OsString>,
    /// 作業ディレクトリ。
    pub cwd: PathBuf,
    /// 追加で渡す環境変数。
    pub envs: Vec<(OsString, OsString)>,
}

impl ProcessSpec {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .current_dir(&self.cwd)
            .envs(self.envs.iter().map(|(k, v)| (k, v)));
        // 自分のプロセスグループの先頭にする。止めるときにグループごと終わらせるため
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
    }
}

/// 子プロセスを、それが起動した孫ごと強制終了する。
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // ProcessSpec::command でグループの先頭にしてあるので、pid がそのままグループの番号
        if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: killpg は番号とシグナルを渡すだけで、メモリには触れない。
            // 対象は自分で起動した子のグループに限られる
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Python 環境を用意する段階の指定 (配布物のみ)。
#[derive(Clone, Debug)]
pub struct SetupSpec {
    /// `uv sync` の起動方法。
    pub process: ProcessSpec,
    /// セットアップが最後まで済んだ印のファイル。中身は、そのとき使った `uv.lock` の指紋。
    ///
    /// 途中で落ちた環境 (venv は在るが依存が揃っていない) を「済み」と見誤らないよう、
    /// venv の有無ではなく、`uv sync` が成功したあとに書くこの印で判断する。
    pub done_marker: PathBuf,
    /// 同梱している `uv.lock` の指紋 (`runtime/lock.sha256`)。
    pub lock_hash: String,
}

impl SetupSpec {
    /// 依存を入れる作業が残っているか (初回、途中で落ちた、アプリの更新で `uv.lock` が変わった)。
    fn needs_install(&self) -> bool {
        std::fs::read_to_string(&self.done_marker)
            .map_or(true, |done| done.trim() != self.lock_hash)
    }
}

/// sidecar の起動に要る設定。
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    /// 起動の前に行う、Python 環境の用意。開発時は None (開発機の環境をそのまま使う)。
    pub setup: Option<SetupSpec>,
    /// sidecar 本体の起動方法。
    pub server: ProcessSpec,
    /// API を呼んでよい origin (CORS の許可先)。
    pub allowed_origins: Vec<String>,
    /// 保存してある API キーを読むときの、キーチェーン上のサービス名 (アプリの識別子)。
    /// `None` ならキーチェーンを読まない (テスト用)。
    pub keychain_service: Option<String>,
}

impl LaunchConfig {
    /// アプリの状態から、sidecar の起動方法を決める。
    ///
    /// - `tauri dev`: 開発機の `uv run` で、リポジトリのコードをそのまま起動する
    /// - 配布物: 同梱した `uv` でアプリのデータ置き場に環境を作り、同梱したコードを起動する
    #[cfg(not(feature = "e2e"))]
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        if tauri::is_dev() {
            Ok(Self::for_dev(app))
        } else {
            Self::for_bundle(app)
        }
    }

    /// 窓を自動操作するテストのビルドでは、いつも [`LaunchConfig::for_e2e`] で起動する。
    #[cfg(feature = "e2e")]
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        Ok(Self::for_e2e(app))
    }

    /// 窓を自動操作するテスト (`make e2e-desktop`) での起動方法。
    ///
    /// 画面は配布物と同じく同梱したもの (`tauri://localhost`、CSP も同じ) を出すが、sidecar は
    /// 開発時と同じく、リポジトリのコードを開発機の `uv run` で起動する。配布物の起動方法
    /// (アプリのデータ置き場に `uv sync` で環境を作る) だと、利用者のデータ置き場に触れ、
    /// 毎回 torch を含む依存を入れ直すことになるため。データの置き場は、テストが環境変数
    /// `BUNRI_DATA_DIR` で一時ディレクトリを渡す (sidecar はそれを受け継ぐ)。
    ///
    /// - CORS の許可先は、配布物と同じ `tauri://localhost` だけ
    /// - キーチェーンは読まない (テストは偽の API キーを環境変数で渡す)
    #[cfg(feature = "e2e")]
    fn for_e2e(app: &AppHandle) -> Self {
        let mut config = Self::for_dev(app);
        config.allowed_origins = vec!["tauri://localhost".to_string()];
        config.keychain_service = None;
        config
    }

    /// sidecar のデータ置き場 (`BUNRI_DATA_DIR`)。sidecar が同じ場所を使うように、渡す環境変数と同じ決め方をする。
    ///
    /// - 起動に渡す環境変数に在ればそれ (配布物: アプリのデータ置き場の `data/`)
    /// - アプリが環境変数で受け取っていればそれ (sidecar はそれを受け継ぐ。テストの一時ディレクトリなど)
    /// - どちらも無ければ作業ディレクトリ (開発時: リポジトリの直下。backend/audio_utils.py の既定と同じ)
    ///
    /// プロジェクトのファイルを写すとき (`project.rs`) に使う。
    pub fn data_dir(&self) -> PathBuf {
        if let Some((_, value)) = self.server.envs.iter().find(|(k, _)| k == "BUNRI_DATA_DIR") {
            return PathBuf::from(value);
        }
        if let Some(value) = std::env::var_os("BUNRI_DATA_DIR") {
            return PathBuf::from(value);
        }
        self.server.cwd.clone()
    }

    /// 開発時の起動方法。
    ///
    /// 環境変数 `BUNRI_UV` で `uv` の場所を、`BUNRI_REPO_ROOT` でリポジトリの場所を上書きできる。
    fn for_dev(app: &AppHandle) -> Self {
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

        let mut allowed_origins = vec!["tauri://localhost".to_string()];
        if let Some(dev_url) = &app.config().build.dev_url {
            allowed_origins.push(dev_url.origin().ascii_serialization());
        }

        Self {
            setup: None,
            server: ProcessSpec {
                program,
                args: [
                    "run",
                    "--frozen",
                    "python",
                    "backend/run_web.py",
                    "--sidecar",
                ]
                .map(OsString::from)
                .to_vec(),
                cwd: repo_root,
                envs: Vec::new(),
            },
            allowed_origins,
            keychain_service: Some(app.config().identifier.clone()),
        }
    }

    /// 配布物での起動方法。
    ///
    /// 置き場 (mac の場合):
    ///
    /// - 同梱物 (読み取り専用): `bunri.app/Contents/MacOS/uv` と
    ///   `bunri.app/Contents/Resources/runtime/` (backend/ と pyproject.toml / uv.lock)
    /// - アプリのデータ置き場 (`~/Library/Application Support/<identifier>/`):
    ///   `runtime/` に Python 本体・venv・uv のキャッシュ、`data/` に利用者のデータ
    ///
    /// アプリの中には何も書き込まない (署名が壊れるため)。
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    fn for_bundle(app: &AppHandle) -> Result<Self, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("同梱物の場所が分かりません: {e}"))?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("データ置き場の場所が分かりません: {e}"))?;
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from))
            .ok_or_else(|| "実行ファイルの場所が分かりません".to_string())?;
        let mut config = Self::bundled(&exe_dir, &resource_dir.join("runtime"), &app_data);
        config.keychain_service = Some(app.config().identifier.clone());
        Ok(config)
    }

    /// 同梱物とデータ置き場の場所から、配布物での起動方法を組み立てる。
    fn bundled(exe_dir: &Path, runtime: &Path, app_data: &Path) -> Self {
        let uv = exe_dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let work = app_data.join("runtime");
        let venv = work.join("venv");
        let python = if cfg!(windows) {
            venv.join("Scripts").join("python.exe")
        } else {
            venv.join("bin").join("python")
        };
        let data_dir = app_data.join("data");

        let setup = ProcessSpec {
            program: uv,
            // --frozen: uv.lock を書き換えない。--no-dev: テストやリントの道具は入れない
            args: [
                OsString::from("sync"),
                "--frozen".into(),
                "--no-dev".into(),
                "--project".into(),
                runtime.as_os_str().to_owned(),
            ]
            .to_vec(),
            cwd: app_data.to_path_buf(),
            envs: vec![
                // venv・Python 本体・キャッシュを、すべてアプリのデータ置き場の中に作る
                ("UV_PROJECT_ENVIRONMENT".into(), venv.as_os_str().to_owned()),
                (
                    "UV_PYTHON_INSTALL_DIR".into(),
                    work.join("python").into_os_string(),
                ),
                (
                    "UV_CACHE_DIR".into(),
                    work.join("uv-cache").into_os_string(),
                ),
                // 利用者の PC に在る Python は使わない (版や壊れ方が分からないため)
                ("UV_PYTHON_PREFERENCE".into(), "only-managed".into()),
                ("UV_NO_PROGRESS".into(), "1".into()),
            ],
        };

        let mut server_envs: Vec<(OsString, OsString)> = vec![
            ("BUNRI_DATA_DIR".into(), data_dir.into_os_string()),
            // .pyc をアプリの中に書かせない
            (
                "PYTHONPYCACHEPREFIX".into(),
                work.join("pycache").into_os_string(),
            ),
        ];
        server_envs.extend(tool_path_envs());

        Self {
            setup: Some(SetupSpec {
                process: setup,
                done_marker: work.join("setup-done"),
                // 読めなければ空。その場合は毎回「依存を入れる作業が残っている」扱いになるだけ
                lock_hash: std::fs::read_to_string(runtime.join("lock.sha256"))
                    .map(|hash| hash.trim().to_string())
                    .unwrap_or_default(),
            }),
            server: ProcessSpec {
                program: python,
                args: [
                    runtime.join("backend").join("run_web.py").into_os_string(),
                    "--sidecar".into(),
                ]
                .to_vec(),
                cwd: app_data.to_path_buf(),
                envs: server_envs,
            },
            allowed_origins: vec!["tauri://localhost".to_string()],
            keychain_service: None,
        }
    }
}

/// 利用者が自分で入れた道具 (ffmpeg / FluidSynth) を sidecar が見つけられるようにする環境変数。
///
/// Finder から起動したアプリの `PATH` は `/usr/bin:/bin` 程度で、Homebrew の置き場が入っていない。
/// そのままだと、`brew install ffmpeg` 済みでも変換機能が ffmpeg を見つけられない。
fn tool_path_envs() -> Vec<(OsString, OsString)> {
    let mut envs = Vec::new();
    if cfg!(unix) {
        let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let extra = PathBuf::from(extra);
            if extra.is_dir() && !paths.contains(&extra) {
                paths.push(extra);
            }
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            envs.push(("PATH".into(), joined));
        }
    }
    // pyfluidsynth は HOMEBREW_PREFIX の下から libfluidsynth を探す
    if cfg!(target_os = "macos") && std::env::var_os("HOMEBREW_PREFIX").is_none() {
        for prefix in ["/opt/homebrew", "/usr/local"] {
            if Path::new(prefix)
                .join("lib")
                .join("libfluidsynth.dylib")
                .exists()
            {
                envs.push(("HOMEBREW_PREFIX".into(), prefix.into()));
                break;
            }
        }
    }
    envs
}

/// 起動の進み具合を持ち、画面に見せる形で更新していく。
///
/// 起動し直したとき (再起動) は、前の起動のスレッドが遅れて「終了した」と書き込まないよう、
/// 自分の世代 (`generation`) がいまの世代と同じときだけ書き込む。
struct Progress {
    tx: Arc<watch::Sender<BootStatus>>,
    /// この起動の世代。
    generation: u64,
    /// いまの世代 (再起動のたびに 1 つ進む)。[`Running::generation`] と同じもの。
    current: Arc<AtomicU64>,
}

impl Progress {
    /// 再起動の無い、単独の進み具合 (テスト用)。
    #[cfg(test)]
    fn standalone(tx: watch::Sender<BootStatus>) -> Self {
        Self {
            tx: Arc::new(tx),
            generation: 0,
            current: Arc::new(AtomicU64::new(0)),
        }
    }

    /// いまの世代のときだけ、状態を書き換えて知らせる。
    fn update(&self, change: impl FnOnce(&mut BootStatus)) {
        self.tx.send_if_modified(|status| {
            if self.current.load(Ordering::SeqCst) != self.generation {
                return false;
            }
            change(status);
            true
        });
    }

    fn set(&self, phase: Phase, message: impl Into<String>) {
        let message = message.into();
        self.update(|status| {
            status.phase = phase;
            status.message = message;
        });
    }

    fn first_run(&self, first_run: bool) {
        self.update(|status| status.first_run = first_run);
    }

    fn log(&self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        self.update(|status| {
            status.log.push(line.to_string());
            let extra = status.log.len().saturating_sub(LOG_TAIL);
            status.log.drain(..extra);
        });
    }

    fn ready(&self, info: BackendInfo) {
        self.update(|status| {
            status.phase = Phase::Ready;
            status.message = "起動しました".into();
            status.info = Some(info);
        });
    }

    fn fail(&self, reason: impl Into<String>) {
        let reason = reason.into();
        self.update(|status| {
            status.phase = Phase::Failed;
            status.message = reason;
            status.info = None;
        });
    }
}

/// いま動かしている子プロセス (セットアップ中は uv、そのあとは sidecar) と、止める指示。
///
/// 子プロセスは、それを起動した世代と一緒に預ける。再起動のあと、前の世代の起動スレッドが
/// 新しい sidecar を取り上げてしまわないように。
#[derive(Default)]
struct Running {
    child: Mutex<Option<(u64, Child)>>,
    /// アプリの終了中か (立ったら、もう起動も再起動もしない)。
    stopping: AtomicBool,
    /// いまの世代。再起動のたびに 1 つ進む。
    generation: Arc<AtomicU64>,
}

impl Running {
    /// 子プロセスを預ける。すでに止める指示が出ていた、または世代が古くなっていたら
    /// (待っている間に再起動された)、その場で終わらせて false を返す。
    fn hold(&self, generation: u64, mut child: Child) -> bool {
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopping.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != generation
        {
            kill_tree(&mut child);
            return false;
        }
        *slot = Some((generation, child));
        true
    }

    /// 預けた子プロセスの終了を待つ (出力を読み切ったあとに呼ぶ)。
    /// 別の世代の子プロセス (再起動で起動し直したもの) には触れない。
    fn wait(&self, generation: u64) -> Option<std::process::ExitStatus> {
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(&*slot, Some((g, _)) if *g == generation) {
            return None;
        }
        let (_, mut child) = slot.take()?;
        drop(slot);
        child.wait().ok()
    }

    /// 預けている子プロセスを取り出す (世代は問わない)。
    fn take(&self) -> Option<Child> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|(_, child)| child)
    }

    /// 預けている子プロセスの番号 (テスト用)。
    #[cfg(test)]
    fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, child)| child.id())
    }
}

/// 子プロセスを終わらせる。
///
/// 標準入力を握っていれば (sidecar)、まずそれを閉じる (sidecar は EOF を見て、自分と子プロセスを終わらせる)。
/// 3 秒待っても終わらなければ kill する。標準入力を握っていない (セットアップ中の uv) なら、すぐ kill する
/// (uv sync は次回の起動で続きから入る)。
fn terminate(mut child: Child) {
    if child.stdin.take().is_some() {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                _ => break,
            }
        }
    }
    kill_tree(&mut child);
}

/// 起動した sidecar。Tauri の state として管理する。
pub struct Sidecar {
    status: watch::Receiver<BootStatus>,
    tx: Arc<watch::Sender<BootStatus>>,
    running: Arc<Running>,
    /// 起動方法。決められなかったときは、その理由 (再起動しても同じ理由で失敗する)。
    config: Result<LaunchConfig, String>,
    /// 再起動を 1 つずつ通す錠 (連打で 2 つの sidecar を起動しないため)。
    restarting: Mutex<()>,
}

impl Sidecar {
    /// 起動を始める。すぐに戻る (待ち受け開始は [`Sidecar::wait_ready`] で待つ)。
    ///
    /// 用意や起動に失敗しても panic せず、状態を「失敗」にする。画面がその理由を表示する。
    pub fn spawn(config: Result<LaunchConfig, String>) -> Self {
        let (tx, rx) = watch::channel(BootStatus::new(Phase::Starting, "bunri を起動しています…"));
        let sidecar = Self {
            status: rx,
            tx: Arc::new(tx),
            running: Arc::new(Running::default()),
            config,
            restarting: Mutex::new(()),
        };
        match &sidecar.config {
            Err(reason) => sidecar.progress(0).fail(reason.clone()),
            Ok(config) => sidecar.start_boot(config.clone(), 0, None),
        }
        sidecar
    }

    /// その世代の進み具合の書き手を作る。
    fn progress(&self, generation: u64) -> Progress {
        Progress {
            tx: Arc::clone(&self.tx),
            generation,
            current: Arc::clone(&self.running.generation),
        }
    }

    /// 起動スレッドを始める。`previous` が在れば、先にそれを終わらせてから起動する。
    fn start_boot(&self, config: LaunchConfig, generation: u64, previous: Option<Child>) {
        let progress = self.progress(generation);
        let running = Arc::clone(&self.running);
        thread::Builder::new()
            .name("sidecar-boot".into())
            .spawn(move || {
                if let Some(child) = previous {
                    terminate(child);
                }
                boot(config, &progress, &running, generation)
            })
            .expect("sidecar の起動スレッドを作れません");
    }

    /// 起動の進み具合を返す (画面が起動待ちの間に繰り返し聞く)。
    pub fn status(&self) -> BootStatus {
        self.status.borrow().clone()
    }

    /// sidecar が待ち受けを始めるまで待ち、接続情報を返す。
    ///
    /// 用意か起動に失敗した、または起動前に終了した場合は、理由を返す。
    pub async fn wait_ready(&self) -> Result<BackendInfo, String> {
        let mut status = self.status.clone();
        let current = status
            .wait_for(|s| matches!(s.phase, Phase::Ready | Phase::Failed))
            .await
            .map_err(|_| "バックエンドの監視が止まりました".to_string())?
            .clone();
        match current.info {
            Some(info) if current.phase == Phase::Ready => Ok(info),
            _ => Err(current.message),
        }
    }

    /// sidecar を起動し直す。すぐに戻る (待ち受け開始は [`Sidecar::wait_ready`] で待つ)。
    ///
    /// 止まった sidecar を画面から起動し直すとき (「再起動」「再試行」) に呼ぶ。動いていても起動し直す
    /// (応答しなくなった sidecar を終わらせるため)。手順は初めの起動と同じ (配布物ではセットアップから)。
    /// ポートとトークンは新しくなるので、画面は [`Sidecar::wait_ready`] で受け取り直す。
    ///
    /// 前の sidecar は、起動スレッドの中で終わらせる (標準入力を閉じて、3 秒で kill)。
    /// 前の起動スレッドが遅れて「終了した」と書き込んでも、世代が違うので無視される。
    ///
    /// 起動方法を決められなかった場合と、アプリの終了中は、理由を返して何もしない。
    pub fn restart(&self) -> Result<(), String> {
        let config = self.config.clone()?;
        let _one_at_a_time = self.restarting.lock().unwrap_or_else(|e| e.into_inner());
        if self.running.stopping.load(Ordering::SeqCst) {
            return Err("終了中です".into());
        }
        // 世代を進めてから取り出す。前の世代の起動スレッドは、このあと子プロセスを預けようとしても断られる
        let generation = self.running.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let previous = self.running.take();
        self.progress(generation).update(|status| {
            *status = BootStatus::new(Phase::Starting, "bunri を起動し直しています…")
        });
        self.start_boot(config, generation, previous);
        Ok(())
    }

    /// 動かしているものを止める。アプリの終了時に呼ぶ。何度呼んでもよい。
    ///
    /// まず標準入力を閉じる (sidecar は EOF を見て、自分と子プロセスを終わらせる)。
    /// 少し待っても終わらなければ kill する。セットアップ中の uv は、すぐ kill してよい
    /// (次回の起動で続きから入る)。
    pub fn stop(&self) {
        self.running.stopping.store(true, Ordering::SeqCst);
        if let Some(child) = self.running.take() {
            terminate(child);
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 起動の本体 (起動スレッドで動く)。セットアップ → sidecar の起動 → 終了までの監視。
fn boot(config: LaunchConfig, progress: &Progress, running: &Running, generation: u64) {
    if let Some(setup) = &config.setup {
        if let Err(reason) = run_setup(setup, progress, running, generation) {
            if !running.stopping.load(Ordering::SeqCst) {
                progress.fail(reason);
            }
            return;
        }
    }
    if running.stopping.load(Ordering::SeqCst) {
        return;
    }
    progress.set(Phase::Starting, "bunri を起動しています…");
    run_server(&config, progress, running, generation);
}

/// Python 環境を用意する (`uv sync`)。出力を進み具合として流す。
fn run_setup(
    setup: &SetupSpec,
    progress: &Progress,
    running: &Running,
    generation: u64,
) -> Result<(), String> {
    let first_run = setup.needs_install();
    progress.first_run(first_run);
    progress.set(
        Phase::Setup,
        if first_run {
            "初回セットアップ中です。音源分離などに使う部品をダウンロードしています（数分かかります）"
        } else {
            "必要な部品を確認しています…"
        },
    );
    std::fs::create_dir_all(&setup.process.cwd).map_err(|e| {
        format!(
            "データ置き場を作れません: {} ({e})",
            setup.process.cwd.display()
        )
    })?;

    let mut child = setup
        .process
        .command()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // uv は進み具合を標準エラーに出す
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "セットアップを始められません: {} を実行できません ({e})",
                setup.process.program.display()
            )
        })?;
    let stderr = child.stderr.take();
    if !running.hold(generation, child) {
        return Err("終了中です".into());
    }

    let mut tail: Vec<String> = Vec::new();
    if let Some(stderr) = stderr {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[setup] {line}");
            progress.log(&line);
            tail.push(line);
            let extra = tail.len().saturating_sub(LOG_TAIL);
            tail.drain(..extra);
        }
    }
    match running.wait(generation) {
        Some(status) if status.success() => {
            // 済んだ印を書く。書けなくても起動は続ける (次回も同じ確認をするだけ)
            if !setup.lock_hash.is_empty() {
                let _ = std::fs::write(&setup.done_marker, &setup.lock_hash);
            }
            Ok(())
        }
        Some(status) => Err(format!(
            "セットアップに失敗しました ({status})。ネットワークと空き容量を確認して、アプリを起動し直してください。済んだぶんは次回に引き継がれます。\n{}",
            tail.join("\n")
        )),
        None => Err("セットアップが中断されました".into()),
    }
}

/// sidecar を起動し、終了するまで標準出力を読み続ける。
fn run_server(config: &LaunchConfig, progress: &Progress, running: &Running, generation: u64) {
    let token = match generate_token() {
        Ok(token) => token,
        Err(reason) => return progress.fail(reason),
    };
    let mut command = config.server.command();
    if let Some(key) = saved_api_key(config) {
        command.env("ANTHROPIC_API_KEY", key);
    }
    let spawned = command
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
            return progress.fail(format!(
                "バックエンドを起動できませんでした: {} を実行できません ({e})。作業ディレクトリ: {}",
                config.server.program.display(),
                config.server.cwd.display(),
            ));
        }
    };
    let stdout = child.stdout.take();
    if !running.hold(generation, child) {
        return;
    }
    if let Some(stdout) = stdout {
        watch_stdout(stdout, token, progress);
    }
    if !running.stopping.load(Ordering::SeqCst) {
        // 自分から終わった (止める指示は出していない)。後始末だけしておく。
        // 再起動で取り出されていれば (別の世代)、何もしない
        let _ = running.wait(generation);
    }
}

/// sidecar に渡す、保存済みの Claude の API キーを返す (無ければ `None`)。
///
/// すでに環境変数 `ANTHROPIC_API_KEY` が在る (開発時にシェルで設定している) ならそちらを使い、
/// キーチェーンは読まない。読めなかったときは、理由をログに出して起動は続ける
/// (キーが無くても、再現ガイド以外は動く)。
fn saved_api_key(config: &LaunchConfig) -> Option<String> {
    let service = config.keychain_service.as_deref()?;
    if std::env::var_os("ANTHROPIC_API_KEY").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    match crate::secrets::load(service) {
        Ok(key) => key,
        Err(reason) => {
            eprintln!("[secrets] {reason}");
            None
        }
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

/// sidecar の標準出力を最後まで読む。
///
/// ポートの知らせを受け取ったら状態を「待ち受け中」にする。それ以外の行はログとして流す。
/// 標準出力が閉じたら sidecar は終了しているので、状態を「失敗」にする。
fn watch_stdout(stdout: impl Read, token: String, progress: &Progress) {
    let mut ready = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if !ready {
            if let Some(port) = parse_announcement(&line) {
                ready = true;
                progress.ready(BackendInfo {
                    port,
                    token: token.clone(),
                });
                continue;
            }
        }
        eprintln!("[backend] {line}");
    }
    progress.fail(if ready {
        "バックエンドが終了しました"
    } else {
        "バックエンドが待ち受けを始める前に終了しました。ターミナルに出ているエラーを確認してください"
    });
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

    fn progress() -> (Progress, watch::Receiver<BootStatus>) {
        let (tx, rx) = watch::channel(BootStatus::new(Phase::Starting, ""));
        (Progress::standalone(tx), rx)
    }

    fn sh(script: &str) -> ProcessSpec {
        ProcessSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            envs: Vec::new(),
        }
    }

    /// 状態が条件を満たすまで待つ (テスト用。最大 5 秒)。
    fn wait_until(sidecar: &Sidecar, done: impl Fn(&BootStatus) -> bool) -> BootStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = sidecar.status();
            if done(&status) || Instant::now() > deadline {
                return status;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

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
        let (progress, rx) = progress();
        let output = "{\"event\": \"listening\", \"port\": 4000}\nINFO: log line\n";
        watch_stdout(output.as_bytes(), "tok".into(), &progress);
        // 最後の状態は「終了した」。接続情報は残さない
        let status = rx.borrow().clone();
        assert_eq!(status.phase, Phase::Failed);
        assert_eq!(status.message, "バックエンドが終了しました");
        assert_eq!(status.info, None);
    }

    #[test]
    fn 知らせの前に出力が閉じたら起動失敗() {
        let (progress, rx) = progress();
        watch_stdout(
            "Traceback (most recent call last):\n".as_bytes(),
            "tok".into(),
            &progress,
        );
        let status = rx.borrow().clone();
        assert_eq!(status.phase, Phase::Failed);
        assert!(status.message.contains("待ち受けを始める前"));
    }

    #[test]
    fn ログは末尾だけ残す() {
        let (progress, rx) = progress();
        for i in 0..(LOG_TAIL + 5) {
            progress.log(&format!("line {i}\n"));
        }
        progress.log("   ");
        let log = rx.borrow().log.clone();
        assert_eq!(log.len(), LOG_TAIL);
        assert_eq!(log.last().unwrap(), &format!("line {}", LOG_TAIL + 4));
    }

    #[test]
    fn 画面に渡す状態にトークンは含めない() {
        let (progress, rx) = progress();
        progress.ready(BackendInfo {
            port: 1,
            token: "secret-token".into(),
        });
        let json = serde_json::to_string(&*rx.borrow()).unwrap();
        assert!(json.contains(r#""phase":"ready""#));
        assert!(!json.contains("secret-token"));
    }

    #[test]
    fn 起動方法を決められなければ理由つきで失敗する() {
        let sidecar = Sidecar::spawn(Err("同梱物の場所が分かりません".into()));
        let status = sidecar.status();
        assert_eq!(status.phase, Phase::Failed);
        assert_eq!(status.message, "同梱物の場所が分かりません");
    }

    #[test]
    fn 実行できないプログラムなら理由つきで失敗する() {
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: None,
            server: ProcessSpec {
                program: PathBuf::from("/nonexistent/bunri-test-program"),
                ..Default::default()
            },
            allowed_origins: vec![],
            keychain_service: None,
        }));
        let status = wait_until(&sidecar, |s| s.phase == Phase::Failed);
        assert_eq!(status.phase, Phase::Failed);
        assert!(
            status.message.contains("実行できません"),
            "{}",
            status.message
        );
    }

    #[test]
    fn 配布物では同梱物とデータ置き場から起動方法を組み立てる() {
        let config = LaunchConfig::bundled(
            Path::new("/Applications/bunri.app/Contents/MacOS"),
            Path::new("/Applications/bunri.app/Contents/Resources/runtime"),
            Path::new("/Users/u/Library/Application Support/io.github.suwakei.bunri"),
        );
        let setup = config.setup.expect("配布物にはセットアップが要る");
        assert_eq!(
            setup.process.program,
            Path::new("/Applications/bunri.app/Contents/MacOS").join(if cfg!(windows) {
                "uv.exe"
            } else {
                "uv"
            })
        );
        let args: Vec<_> = setup
            .process
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "sync",
                "--frozen",
                "--no-dev",
                "--project",
                "/Applications/bunri.app/Contents/Resources/runtime"
            ]
        );

        // 書き込む先は、すべてアプリのデータ置き場の中 (アプリの中には書かない)
        let app_data = "/Users/u/Library/Application Support/io.github.suwakei.bunri";
        let written = [
            "UV_PROJECT_ENVIRONMENT",
            "UV_PYTHON_INSTALL_DIR",
            "UV_CACHE_DIR",
        ];
        for (key, value) in &setup.process.envs {
            if written.contains(&key.to_string_lossy().as_ref()) {
                assert!(
                    value.to_string_lossy().starts_with(app_data),
                    "{key:?}={value:?}"
                );
            }
        }
        for key in ["BUNRI_DATA_DIR", "PYTHONPYCACHEPREFIX"] {
            let value = config
                .server
                .envs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.to_string_lossy().into_owned());
            assert!(
                value.is_some_and(|v| v.starts_with(app_data)),
                "{key} がデータ置き場を指していない"
            );
        }
        assert!(setup.done_marker.starts_with(app_data));
        assert!(config.server.program.starts_with(app_data));
        assert!(config.server.program.to_string_lossy().contains("venv"));
        assert_eq!(config.allowed_origins, ["tauri://localhost"]);
    }

    /// 本物の子プロセスで、知らせの受け取りと、stop() で終わることを確かめる (POSIX のシェルを使う)。
    #[cfg(unix)]
    #[test]
    fn 子プロセスの知らせを受け取り_stopで終わらせる() {
        // 知らせを出したあと、標準入力が閉じるまで待つだけの「sidecar もどき」
        let script = r#"echo "{\"event\": \"listening\", \"port\": 4321}"; cat > /dev/null"#;
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: None,
            server: sh(script),
            allowed_origins: vec!["tauri://localhost".into()],
            keychain_service: None,
        }));
        let status = wait_until(&sidecar, |s| s.phase != Phase::Starting);
        assert_eq!(status.phase, Phase::Ready, "{}", status.message);
        let info = status.info.unwrap();
        assert_eq!(info.port, 4321);
        assert_eq!(info.token.len(), 64);

        let pid = sidecar.running.pid().unwrap();
        let started = Instant::now();
        sidecar.stop();
        // 標準入力を閉じただけで終わるので、kill の待ち時間 (3 秒) より十分早い
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!alive(pid), "stop() のあとも子プロセスが残っている");
    }

    #[cfg(unix)]
    #[test]
    fn セットアップの出力が進み具合になり_済んでから起動する() {
        let dir = std::env::temp_dir().join(format!("bunri-test-{}", std::process::id()));
        let marker = dir.join("venv-python");
        let _ = std::fs::remove_dir_all(&dir);
        let mut setup = sh(&format!(
            "echo 'Downloading torch (75.0MiB)' >&2; echo 'Installed 84 packages' >&2; touch '{}'",
            marker.display()
        ));
        setup.cwd = dir.clone();
        let server = sh(&format!(
            r#"test -f '{}' && echo "{{\"event\": \"listening\", \"port\": 5000}}"; cat > /dev/null"#,
            marker.display()
        ));
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: Some(SetupSpec {
                process: setup,
                done_marker: dir.join("setup-done"),
                lock_hash: "abc123".into(),
            }),
            server,
            allowed_origins: vec![],
            keychain_service: None,
        }));
        let status = wait_until(&sidecar, |s| {
            matches!(s.phase, Phase::Ready | Phase::Failed)
        });
        assert_eq!(status.phase, Phase::Ready, "{}", status.message);
        assert!(status.first_run, "済んだ印が無かったので初回のはず");
        assert_eq!(
            status.log,
            ["Downloading torch (75.0MiB)", "Installed 84 packages"]
        );
        sidecar.stop();
        // 成功したら、使ったロックの指紋を印として残す
        assert_eq!(
            std::fs::read_to_string(dir.join("setup-done")).unwrap(),
            "abc123"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 済んだ印がロックの指紋と合うときだけ_依存は揃っていると見なす() {
        let dir = std::env::temp_dir().join(format!("bunri-test-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let spec = SetupSpec {
            process: ProcessSpec::default(),
            done_marker: dir.join("setup-done"),
            lock_hash: "abc123".into(),
        };
        assert!(spec.needs_install(), "印が無ければ、初回か途中で落ちた");
        std::fs::write(&spec.done_marker, "abc123\n").unwrap();
        assert!(!spec.needs_install());
        std::fs::write(&spec.done_marker, "old-lock").unwrap();
        assert!(spec.needs_install(), "アプリの更新で uv.lock が変わった");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn セットアップが失敗したら起動せず_理由と出力を見せる() {
        let dir = std::env::temp_dir().join(format!("bunri-test-fail-{}", std::process::id()));
        let marker = dir.join("setup-done");
        let _ = std::fs::remove_dir_all(&dir);
        let mut setup = sh("echo 'error: Failed to fetch' >&2; exit 2");
        setup.cwd = dir.clone();
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: Some(SetupSpec {
                process: setup,
                done_marker: marker.clone(),
                lock_hash: "abc123".into(),
            }),
            server: sh(r#"echo "{\"event\": \"listening\", \"port\": 5001}"; cat > /dev/null"#),
            allowed_origins: vec![],
            keychain_service: None,
        }));
        let status = wait_until(&sidecar, |s| {
            matches!(s.phase, Phase::Ready | Phase::Failed)
        });
        assert_eq!(status.phase, Phase::Failed);
        assert!(
            status.message.contains("セットアップに失敗しました"),
            "{}",
            status.message
        );
        assert!(status.message.contains("error: Failed to fetch"));
        assert!(
            sidecar.running.pid().is_none(),
            "失敗したのに sidecar を起動している"
        );
        assert!(!marker.exists(), "失敗したのに済んだ印を書いている");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn セットアップ中に止めたら_uvを終わらせ_sidecarは起動しない() {
        let dir = std::env::temp_dir().join(format!("bunri-test-stop-{}", std::process::id()));
        let started = dir.join("server-started");
        let _ = std::fs::remove_dir_all(&dir);
        let mut setup = sh("echo 'Downloading torch' >&2; sleep 30");
        setup.cwd = dir.clone();
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: Some(SetupSpec {
                process: setup,
                done_marker: dir.join("setup-done"),
                lock_hash: "abc123".into(),
            }),
            server: sh(&format!("touch '{}'; cat > /dev/null", started.display())),
            allowed_origins: vec![],
            keychain_service: None,
        }));
        let status = wait_until(&sidecar, |s| !s.log.is_empty());
        assert_eq!(status.phase, Phase::Setup);
        let pid = sidecar.running.pid().unwrap();

        let begun = Instant::now();
        sidecar.stop();
        assert!(
            begun.elapsed() < Duration::from_secs(2),
            "セットアップ中の stop() は待たずに終わらせる"
        );
        assert!(!alive(pid), "stop() のあとも uv が残っている");
        // uv が起動していた孫 (ここでは sleep) も残さない
        let orphans = Command::new("pgrep")
            .args(["-g", &pid.to_string()])
            .output()
            .unwrap();
        assert!(
            orphans.stdout.is_empty(),
            "孫プロセスが残っている: {}",
            String::from_utf8_lossy(&orphans.stdout)
        );
        thread::sleep(Duration::from_millis(300));
        assert!(!started.exists(), "止めたのに sidecar を起動している");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 起動するたびに違うポートを知らせる「sidecar もどき」。何回目かを `counter` に数える。
    /// `die_first` なら、1 回目は知らせたあとすぐ終わる (sidecar が落ちた状態を作る)。
    #[cfg(unix)]
    fn counting_server(counter: &Path, die_first: bool) -> ProcessSpec {
        let die = if die_first {
            r#"[ "$n" = 1 ] && exit 0;"#
        } else {
            ""
        };
        sh(&format!(
            r#"n=$(cat '{c}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '{c}'; echo "{{\"event\": \"listening\", \"port\": $((4000+n))}}"; {die} cat > /dev/null"#,
            c = counter.display()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn 再起動すると新しいポートとトークンで待ち受け_前のsidecarは終わる() {
        let dir = std::env::temp_dir().join(format!("bunri-test-restart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: None,
            server: counting_server(&dir.join("count"), false),
            allowed_origins: vec![],
            keychain_service: None,
        }));
        let first = wait_until(&sidecar, |s| s.phase == Phase::Ready)
            .info
            .unwrap();
        assert_eq!(first.port, 4001);
        let old_pid = sidecar.running.pid().unwrap();

        sidecar.restart().unwrap();
        // 戻った直後から「起動中」。画面はこのあと wait_ready で新しい接続情報を待つ
        assert_eq!(sidecar.status().phase, Phase::Starting);
        let status = wait_until(&sidecar, |s| {
            s.info.as_ref().is_some_and(|i| i.port == 4002)
        });
        assert_eq!(status.phase, Phase::Ready, "{}", status.message);
        let second = status.info.unwrap();
        assert_ne!(second.token, first.token, "トークンも作り直す");
        let new_pid = sidecar.running.pid().unwrap();
        assert_ne!(new_pid, old_pid);
        assert!(alive(new_pid));
        assert!(!alive(old_pid), "前の sidecar が残っている");
        // 前の sidecar が終わったこと (出力が閉じた) で、状態が「失敗」に戻ったりしない
        thread::sleep(Duration::from_millis(200));
        assert_eq!(sidecar.status().phase, Phase::Ready);

        sidecar.stop();
        assert!(
            !alive(new_pid),
            "stop() のあとも再起動した sidecar が残っている"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn 止まったsidecarを再起動できる() {
        let dir =
            std::env::temp_dir().join(format!("bunri-test-restart-dead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: None,
            server: counting_server(&dir.join("count"), true),
            allowed_origins: vec![],
            keychain_service: None,
        }));
        // 1 回目は、待ち受けを始めたあとに終わる (落ちた)
        let dead = wait_until(&sidecar, |s| s.phase == Phase::Failed);
        assert_eq!(dead.phase, Phase::Failed);
        assert_eq!(dead.message, "バックエンドが終了しました");

        sidecar.restart().unwrap();
        let status = wait_until(&sidecar, |s| s.phase == Phase::Ready);
        assert_eq!(status.phase, Phase::Ready, "{}", status.message);
        assert_eq!(status.info.unwrap().port, 4002);
        let pid = sidecar.running.pid().unwrap();
        sidecar.stop();
        assert!(!alive(pid));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 前の世代の知らせは_再起動したあとの状態を書き換えない() {
        let (tx, rx) = watch::channel(BootStatus::new(Phase::Starting, ""));
        let tx = Arc::new(tx);
        let current = Arc::new(AtomicU64::new(0));
        let old = Progress {
            tx: Arc::clone(&tx),
            generation: 0,
            current: Arc::clone(&current),
        };
        let new = Progress {
            tx,
            generation: 1,
            current: Arc::clone(&current),
        };
        current.store(1, Ordering::SeqCst);
        new.ready(BackendInfo {
            port: 4002,
            token: "new".into(),
        });
        // 前の sidecar の出力が遅れて閉じた
        old.fail("バックエンドが終了しました");
        old.log("old line");
        let status = rx.borrow().clone();
        assert_eq!(status.phase, Phase::Ready);
        assert_eq!(status.info.unwrap().port, 4002);
        assert!(status.log.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn 前の世代の子プロセスは_新しい世代に預けられない() {
        let running = Running::default();
        running.generation.store(1, Ordering::SeqCst);
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        let pid = child.id();
        // 待っている間に再起動された起動スレッドが、古い世代で預けようとした
        assert!(!running.hold(0, child));
        assert!(running.pid().is_none());
        thread::sleep(Duration::from_millis(100));
        assert!(
            !alive(pid),
            "預けられなかった子プロセスは、その場で終わらせる"
        );
        // 別の世代の wait は、いまの子プロセスに触れない
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        assert!(running.hold(1, child));
        assert!(running.wait(0).is_none());
        assert!(running.pid().is_some());
        terminate(running.take().unwrap());
    }

    #[test]
    fn 起動方法を決められないときは_再起動しても同じ理由で失敗する() {
        let sidecar = Sidecar::spawn(Err("同梱物の場所が分かりません".into()));
        assert_eq!(
            sidecar.restart(),
            Err("同梱物の場所が分かりません".to_string())
        );
        assert_eq!(sidecar.status().phase, Phase::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn 終了中は再起動しない() {
        let sidecar = Sidecar::spawn(Ok(LaunchConfig {
            setup: None,
            server: sh(r#"echo "{\"event\": \"listening\", \"port\": 4999}"; cat > /dev/null"#),
            allowed_origins: vec![],
            keychain_service: None,
        }));
        wait_until(&sidecar, |s| s.phase == Phase::Ready);
        sidecar.stop();
        assert_eq!(sidecar.restart(), Err("終了中です".to_string()));
        thread::sleep(Duration::from_millis(200));
        assert!(sidecar.running.pid().is_none(), "終了中なのに起動している");
    }
}
