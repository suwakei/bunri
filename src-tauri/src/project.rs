//! プロジェクトのファイル (`.bunri`) の置き場と、保存していない変更を守る仕組み。
//!
//! ## 誰がどこを読み書きするか
//!
//! sidecar (Python) はデータ置き場の中しか読み書きしない。利用者が選んだ場所 (`~/Documents/bunri/曲名.bunri`
//! など) との間で写すのは、ここ (Rust) だけ。
//!
//! - 保存: sidecar が `<データ置き場>/work/<token>.bunri` に書く → [`ProjectFiles::commit`] が、
//!   保存のダイアログで選ばれた場所へ写す
//! - 開く: 開くダイアログで選ばれたファイル (か、最近使ったプロジェクト) を、[`ProjectFiles::open_into_work`] が
//!   `work/<token>.bunri` へ写す → sidecar がそれを開く
//!
//! 写してよい行き先は「このアプリのダイアログで利用者が選んだ場所」と「最近使ったプロジェクトに在る場所」
//! (これもダイアログで選ばれたものだけが入る) に限る。画面 (WebView) が乗っ取られて任意のパスを渡してきても、
//! 利用者が選んでいない場所には書かない。決めた理由は docs/desktop-architecture.md「プロジェクトのファイル」。
//!
//! ## 保存していない変更
//!
//! 画面が「保存していない変更が在るか」を [`DocumentState`] に知らせておく。窓を閉じる・アプリを終える要求が
//! 来たとき、変更が在れば止めて画面に尋ねさせる (保存 / 保存しない / キャンセル)。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// 作業用の写しの名前の長さ (16 進)。backend/project_store.py の `_TOKEN_RE` と合わせる。
pub const TOKEN_LEN: usize = 24;
/// 最近使ったプロジェクトを置くファイル (データ置き場の直下)。
const RECENT_FILE: &str = "recent-projects.json";
/// 最近使ったプロジェクトの数の上限。
const RECENT_LIMIT: usize = 12;
/// 窓を閉じる・アプリを終える前に、画面に尋ねさせるイベントの名前。
pub const CLOSE_EVENT: &str = "close-requested";
/// メインの窓のラベル。
const MAIN_LABEL: &str = "main";

/// 最近使ったプロジェクトの 1 件。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentEntry {
    /// ファイルの場所 (絶対パス)。
    pub path: PathBuf,
    /// 最後に開いた・保存した時刻 (UNIX 秒)。
    pub opened_at: u64,
}

/// 最近使ったプロジェクトの一覧。新しいものが先頭。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentList {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: Vec<RecentEntry>,
}

impl RecentList {
    /// ファイルから読む。無い・壊れているときは空 (一覧が消えるだけで、プロジェクトは消えない)。
    pub fn load(file: &Path) -> Self {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<RecentList>(&text).ok())
            .map(|mut list| {
                list.entries.retain(|e| e.path.is_absolute());
                list.entries.truncate(RECENT_LIMIT);
                list
            })
            .unwrap_or_default()
    }

    /// ファイルに書く (別名に書いてから置き換える)。
    pub fn save(&self, file: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&RecentList {
            version: 1,
            entries: self.entries.clone(),
        })
        .map_err(|e| e.to_string())?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, file).map_err(|e| e.to_string())
    }

    /// 先頭に置く (在れば移す)。上限を超えたぶんは古いものから外す。
    pub fn touch(&mut self, path: &Path, now: u64) {
        self.entries.retain(|e| e.path != path);
        self.entries.insert(
            0,
            RecentEntry {
                path: path.to_path_buf(),
                opened_at: now,
            },
        );
        self.entries.truncate(RECENT_LIMIT);
    }

    /// 一覧から外す (ファイルは消さない)。外したら true。
    pub fn remove(&mut self, path: &Path) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.path != path);
        before != self.entries.len()
    }

    /// 一覧に在るか。
    pub fn contains(&self, path: &Path) -> bool {
        self.entries.iter().any(|e| e.path == path)
    }

    /// 一覧。
    pub fn entries(&self) -> &[RecentEntry] {
        &self.entries
    }
}

/// 画面に見せる、最近使ったプロジェクトの 1 件。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RecentView {
    pub path: String,
    pub name: String,
    /// ファイルがいまも在るか (無ければ画面は「見つかりません」と出す)。
    pub exists: bool,
    pub opened_at: u64,
}

/// 開いたファイル (作業用の写しの名前つき)。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub token: String,
}

/// 保存したファイル。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SavedFile {
    pub path: String,
    pub name: String,
}

/// 窓を閉じる要求をどうするか。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// そのまま閉じる。
    Allow,
    /// 止めて、画面に尋ねさせる。
    AskUi,
}

/// いま開いているプロジェクトに、保存していない変更が在るか。
#[derive(Debug, Default)]
pub struct DocumentState {
    dirty: bool,
    /// 利用者が「保存」か「保存しない」を選んだ (次の閉じる要求は止めない)。
    confirmed: bool,
}

impl DocumentState {
    /// 画面から、保存していない変更が在るかを受け取る。
    pub fn set_dirty(&mut self, dirty: bool) {
        self.dirty = dirty;
        if dirty {
            self.confirmed = false;
        }
    }

    /// 閉じる要求が来たときに、どうするかを決める。
    pub fn decide_close(&self) -> CloseDecision {
        if self.confirmed || !self.dirty {
            CloseDecision::Allow
        } else {
            CloseDecision::AskUi
        }
    }

    /// 利用者が選び終えた (保存した、または保存しないと決めた)。このあとの閉じる・終えるは止めない。
    pub fn confirm(&mut self) {
        self.confirmed = true;
        self.dirty = false;
    }
}

/// プロジェクトのファイルの置き場と、写してよい場所。
pub struct ProjectFiles {
    /// sidecar のデータ置き場。起動方法を決められなかったときは None (プロジェクトの操作は失敗させる)。
    data_dir: Option<PathBuf>,
    /// このアプリのダイアログで利用者が選んだ場所 (この起動のあいだだけ覚える)。
    granted: Mutex<HashSet<PathBuf>>,
    recent: Mutex<RecentList>,
    pub document: Mutex<DocumentState>,
}

impl ProjectFiles {
    /// データ置き場を受け取り、最近使ったプロジェクトを読む。
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let recent = data_dir
            .as_ref()
            .map(|d| RecentList::load(&d.join(RECENT_FILE)))
            .unwrap_or_default();
        Self {
            data_dir,
            granted: Mutex::new(HashSet::new()),
            recent: Mutex::new(recent),
            document: Mutex::new(DocumentState::default()),
        }
    }

    fn data_dir(&self) -> Result<&Path, String> {
        self.data_dir
            .as_deref()
            .ok_or_else(|| "データの置き場が分からないので、プロジェクトを扱えません".to_string())
    }

    fn save_recent(&self, list: &RecentList) {
        if let Some(dir) = &self.data_dir {
            if let Err(e) = list.save(&dir.join(RECENT_FILE)) {
                eprintln!("[project] 最近使ったプロジェクトを書けませんでした: {e}");
            }
        }
    }

    /// ダイアログで選ばれた場所を、写してよい場所に加える。
    pub fn grant(&self, path: &Path) {
        self.granted.lock().unwrap().insert(normalize(path));
    }

    /// 写してよい場所か (ダイアログで選ばれた、または最近使ったプロジェクトに在る)。
    pub fn is_allowed(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.granted.lock().unwrap().contains(&path) || self.recent.lock().unwrap().contains(&path)
    }

    /// 作業用の写しの場所。
    pub fn work_path(&self, token: &str) -> Result<PathBuf, String> {
        validate_token(token)?;
        Ok(self.data_dir()?.join("work").join(format!("{token}.bunri")))
    }

    /// sidecar が書いた作業用の写しを、利用者が選んだ場所へ写す (保存)。
    pub fn commit(&self, token: &str, dest: &Path, now: u64) -> Result<SavedFile, String> {
        ensure_bunri(dest)?;
        if !self.is_allowed(dest) {
            return Err("保存先は、保存のダイアログで選んでください".into());
        }
        let src = self.work_path(token)?;
        if !src.is_file() {
            return Err("保存するプロジェクトが見つかりません。もう一度保存してください".into());
        }
        copy_atomic(&src, dest)?;
        let dest = normalize(dest);
        self.grant(&dest);
        let mut recent = self.recent.lock().unwrap();
        recent.touch(&dest, now);
        self.save_recent(&recent);
        Ok(SavedFile {
            path: dest.display().to_string(),
            name: display_name(&dest),
        })
    }

    /// 選ばれたファイルを作業用の写しへ写す (開く)。
    pub fn open_into_work(&self, src: &Path, now: u64) -> Result<OpenedFile, String> {
        ensure_bunri(src)?;
        if !src.is_file() {
            return Err(format!(
                "「{}」が見つかりません。移動したか、消した可能性があります",
                display_name(src)
            ));
        }
        let token = new_token()?;
        let dst = self.work_path(&token)?;
        if let Some(dir) = dst.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, &dst).map_err(|e| format!("ファイルを読めませんでした: {e}"))?;
        let src = normalize(src);
        self.grant(&src);
        let mut recent = self.recent.lock().unwrap();
        recent.touch(&src, now);
        self.save_recent(&recent);
        Ok(OpenedFile {
            path: src.display().to_string(),
            name: display_name(&src),
            token,
        })
    }

    /// 最近使ったプロジェクト (かこの起動で選ばれた場所) を開く。それ以外の場所は断る。
    pub fn open_known(&self, path: &Path, now: u64) -> Result<OpenedFile, String> {
        if !self.is_allowed(path) {
            return Err("このファイルは「開く」から選んでください".into());
        }
        self.open_into_work(path, now)
    }

    /// 画面に見せる、最近使ったプロジェクト。
    pub fn recent_views(&self) -> Vec<RecentView> {
        self.recent
            .lock()
            .unwrap()
            .entries()
            .iter()
            .map(|e| RecentView {
                path: e.path.display().to_string(),
                name: display_name(&e.path),
                exists: e.path.is_file(),
                opened_at: e.opened_at,
            })
            .collect()
    }

    /// 最近使ったプロジェクトから外す (ファイルは消さない)。
    pub fn remove_recent(&self, path: &Path) {
        let mut recent = self.recent.lock().unwrap();
        if recent.remove(&normalize(path)) {
            self.save_recent(&recent);
        }
    }
}

/// パスを比べられる形にする (親のディレクトリが在れば実体のパスに直す。ファイルはまだ無くてよい)。
fn normalize(path: &Path) -> PathBuf {
    let Some(name) = path.file_name() else {
        return path.to_path_buf();
    };
    match path.parent().map(std::fs::canonicalize) {
        Some(Ok(parent)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// 作業用の写しの名前か (24 桁の小文字 16 進)。パスの区切りなどを含む名前で、置き場の外を指させない。
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.len() == TOKEN_LEN
        && token
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        Ok(())
    } else {
        Err("プロジェクトの指定が正しくありません".into())
    }
}

/// `.bunri` の絶対パスか。
pub fn ensure_bunri(path: &Path) -> Result<(), String> {
    let is_bunri = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bunri"));
    if path.is_absolute() && is_bunri {
        Ok(())
    } else {
        Err("扱えるのは .bunri のファイルだけです".into())
    }
}

/// 拡張子が無ければ `.bunri` を付ける (保存のダイアログで拡張子を消されたとき)。
pub fn with_bunri_extension(path: PathBuf) -> PathBuf {
    if ensure_bunri(&path).is_ok() || !path.is_absolute() {
        path
    } else {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".bunri");
        path.with_file_name(name)
    }
}

/// 保存のダイアログに出す、ファイル名の候補 (パスの区切りや制御文字を除く)。
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(80).collect();
    if limited.is_empty() {
        "無題のプロジェクト".into()
    } else {
        limited
    }
}

/// 別名に写してから置き換える (書きかけのファイルを、利用者のファイルとして残さない)。
fn copy_atomic(src: &Path, dest: &Path) -> Result<(), String> {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dest.with_file_name(format!(".{name}.saving"));
    if let Err(e) = std::fs::copy(src, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存できませんでした: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存できませんでした: {e}"));
    }
    Ok(())
}

fn display_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_LEN / 2];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// いまの時刻 (UNIX 秒)。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---- コマンド ----

/// 保存のダイアログを出し、選ばれた場所を返す (取り消したら None)。選ばれた場所は写してよい場所になる。
///
/// 既定の場所は `~/Documents/bunri/<曲名>.bunri`。テスト用のビルドでは、ダイアログを出さずに
/// 環境変数 `BUNRI_E2E_SAVE_PATH` の場所を返す (WebDriver はネイティブのダイアログを操作できないため)。
#[tauri::command]
pub async fn project_pick_save(
    app: AppHandle,
    files: State<'_, ProjectFiles>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = pick_save_path(&app, &suggested_name).await? else {
        return Ok(None);
    };
    let path = with_bunri_extension(path);
    ensure_bunri(&path)?;
    files.grant(&path);
    Ok(Some(path.display().to_string()))
}

async fn pick_save_path(app: &AppHandle, suggested_name: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::e2e::dialog_path(crate::e2e::SAVE_PATH_ENV) {
        return Ok(Some(path));
    }
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("プロジェクトを保存")
        .add_filter("bunri のプロジェクト", &["bunri"])
        .set_file_name(format!("{}.bunri", sanitize_file_name(suggested_name)));
    if let Ok(documents) = app.path().document_dir() {
        let dir = documents.join("bunri");
        if dir.is_dir() || std::fs::create_dir_all(&dir).is_ok() {
            dialog = dialog.set_directory(dir);
        }
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "保存先を選べませんでした".to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()))
}

/// 開くダイアログを出し、選ばれたファイルを作業用の写しへ写して返す (取り消したら None)。
///
/// テスト用のビルドでは、ダイアログを出さずに環境変数 `BUNRI_E2E_OPEN_PATH` の場所を開く。
#[tauri::command]
pub async fn project_pick_open(
    app: AppHandle,
    files: State<'_, ProjectFiles>,
) -> Result<Option<OpenedFile>, String> {
    let Some(path) = pick_open_path(&app).await? else {
        return Ok(None);
    };
    files.open_into_work(&path, now_secs()).map(Some)
}

async fn pick_open_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::e2e::dialog_path(crate::e2e::OPEN_PATH_ENV) {
        return Ok(Some(path));
    }
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("プロジェクトを開く")
        .add_filter("bunri のプロジェクト", &["bunri"]);
    if let Ok(documents) = app.path().document_dir() {
        let dir = documents.join("bunri");
        if dir.is_dir() {
            dialog = dialog.set_directory(dir);
        }
    }
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "ファイルを選べませんでした".to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()))
}

/// 作業用の写しを、選ばれた場所へ写す (保存)。行き先は、ダイアログで選ばれた場所か、最近使ったプロジェクトだけ。
#[tauri::command]
pub fn project_commit(
    files: State<'_, ProjectFiles>,
    token: String,
    path: String,
) -> Result<SavedFile, String> {
    files.commit(&token, Path::new(&path), now_secs())
}

/// 最近使ったプロジェクトを開く (一覧に在るものだけ)。
#[tauri::command]
pub fn project_open_recent(
    files: State<'_, ProjectFiles>,
    path: String,
) -> Result<OpenedFile, String> {
    files.open_known(Path::new(&path), now_secs())
}

/// 最近使ったプロジェクトの一覧。
#[tauri::command]
pub fn recent_projects(files: State<'_, ProjectFiles>) -> Vec<RecentView> {
    files.recent_views()
}

/// 最近使ったプロジェクトから外す (ファイルは消さない)。
#[tauri::command]
pub fn recent_project_remove(files: State<'_, ProjectFiles>, path: String) {
    files.remove_recent(Path::new(&path));
}

/// 画面から、窓の題名と、保存していない変更が在るかを受け取る (メインの窓だけ)。
#[tauri::command]
pub fn document_state(
    window: tauri::WebviewWindow,
    files: State<'_, ProjectFiles>,
    dirty: bool,
    title: String,
) {
    if window.label() != MAIN_LABEL {
        return;
    }
    files.document.lock().unwrap().set_dirty(dirty);
    let _ = window.set_title(&title);
}

/// 画面で「保存」か「保存しない」を選び終えたので、止めていた閉じる (か終える) を続ける。
#[tauri::command]
pub fn close_confirmed(app: AppHandle, files: State<'_, ProjectFiles>, quit: bool) {
    files.document.lock().unwrap().confirm();
    if quit {
        app.exit(0);
    } else if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.close();
    }
}

/// メインの窓を閉じる要求を受けたとき。保存していない変更が在れば止めて、画面に尋ねさせる。
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != MAIN_LABEL {
        return;
    }
    let Some(files) = window.try_state::<ProjectFiles>() else {
        return;
    };
    if files.document.lock().unwrap().decide_close() == CloseDecision::AskUi {
        api.prevent_close();
        let _ = window.emit(CLOSE_EVENT, serde_json::json!({ "quit": false }));
    }
}

/// アプリを終える要求 (⌘Q) を受けたとき。保存していない変更が在れば止めて、画面に尋ねさせる。
///
/// 戻り値が true なら止めた。
pub fn on_exit_requested(app: &AppHandle) -> bool {
    let Some(files) = app.try_state::<ProjectFiles>() else {
        return false;
    };
    if files.document.lock().unwrap().decide_close() != CloseDecision::AskUi {
        return false;
    }
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return false;
    };
    let _ = window.emit(CLOSE_EVENT, serde_json::json!({ "quit": true }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bunri-project-test-{name}-{}",
            new_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn 最近使ったプロジェクトは新しい順で重ならず上限まで() {
        let mut list = RecentList::default();
        for i in 0..15 {
            list.touch(Path::new(&format!("/tmp/{i}.bunri")), i);
        }
        list.touch(Path::new("/tmp/3.bunri"), 100);
        assert_eq!(list.entries().len(), RECENT_LIMIT);
        assert_eq!(list.entries()[0].path, Path::new("/tmp/3.bunri"));
        assert_eq!(list.entries()[0].opened_at, 100);
        assert_eq!(
            list.entries()
                .iter()
                .filter(|e| e.path == Path::new("/tmp/3.bunri"))
                .count(),
            1
        );
        assert!(list.remove(Path::new("/tmp/3.bunri")));
        assert!(!list.remove(Path::new("/tmp/3.bunri")));
    }

    #[test]
    fn 最近使ったプロジェクトは書いて読み直せて_壊れていたら空() {
        let dir = temp_dir("recent");
        let file = dir.join(RECENT_FILE);
        assert_eq!(RecentList::load(&file), RecentList::default());
        let mut list = RecentList::default();
        list.touch(Path::new("/Users/a/曲.bunri"), 5);
        list.save(&file).unwrap();
        let back = RecentList::load(&file);
        assert_eq!(back.entries(), list.entries());
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(RecentList::load(&file), RecentList::default());
        // 相対パスは読み飛ばす
        std::fs::write(
            &file,
            r#"{"version":1,"entries":[{"path":"rel.bunri","opened_at":1}]}"#,
        )
        .unwrap();
        assert!(RecentList::load(&file).entries().is_empty());
    }

    #[test]
    fn 写しの名前は24桁の16進だけ() {
        assert!(validate_token("0123456789abcdef01234567").is_ok());
        for bad in [
            "",
            "../../etc/passwd",
            "0123456789ABCDEF01234567",
            "0123456789abcdef0123456",
            "0123456789abcdef012345678",
            "0123456789abcdef0123456/",
        ] {
            assert!(validate_token(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn 拡張子と絶対パスを確かめる() {
        assert!(ensure_bunri(Path::new("/a/b.bunri")).is_ok());
        assert!(ensure_bunri(Path::new("/a/b.BUNRI")).is_ok());
        assert!(ensure_bunri(Path::new("b.bunri")).is_err());
        assert!(ensure_bunri(Path::new("/a/b.json")).is_err());
        assert!(ensure_bunri(Path::new("/a/.ssh/authorized_keys")).is_err());
        assert_eq!(
            with_bunri_extension(PathBuf::from("/a/曲")),
            PathBuf::from("/a/曲.bunri")
        );
        assert_eq!(
            with_bunri_extension(PathBuf::from("/a/曲.bunri")),
            PathBuf::from("/a/曲.bunri")
        );
        assert_eq!(sanitize_file_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_file_name("  ..  "), "無題のプロジェクト");
    }

    #[test]
    fn 保存はダイアログで選ばれた場所にだけ写す() {
        let data = temp_dir("data");
        let out = temp_dir("out");
        let files = ProjectFiles::new(Some(data.clone()));
        let token = "0123456789abcdef01234567";
        std::fs::create_dir_all(data.join("work")).unwrap();
        std::fs::write(data.join("work").join(format!("{token}.bunri")), b"doc").unwrap();

        let dest = out.join("曲.bunri");
        // 選ばれていない場所には書かない
        assert!(files.commit(token, &dest, 1).is_err());
        assert!(!dest.exists());
        files.grant(&dest);
        let saved = files.commit(token, &dest, 1).unwrap();
        assert_eq!(saved.name, "曲");
        assert_eq!(std::fs::read(&dest).unwrap(), b"doc");
        // 書きかけの別名は残らない
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), 1);
        // 最近使ったプロジェクトに入り、ファイルにも書かれる
        assert_eq!(files.recent_views()[0].path, dest.display().to_string());
        assert!(data.join(RECENT_FILE).exists());
        // 置き場の外を指す名前は断る
        assert!(files.commit("../../../etc/passwd", &dest, 1).is_err());
        // .bunri 以外には書かない
        let other = out.join("x.sh");
        files.grant(&other);
        assert!(files.commit(token, &other, 1).is_err());
    }

    #[test]
    fn 開くのは選ばれた場所か最近使ったプロジェクトだけ_無ければ分かる文で断る() {
        let data = temp_dir("data2");
        let out = temp_dir("out2");
        let files = ProjectFiles::new(Some(data.clone()));
        let src = out.join("a.bunri");
        std::fs::write(&src, b"doc").unwrap();
        assert!(files.open_known(&src, 1).is_err());
        let opened = files.open_into_work(&src, 2).unwrap();
        assert_eq!(opened.name, "a");
        assert_eq!(
            std::fs::read(files.work_path(&opened.token).unwrap()).unwrap(),
            b"doc"
        );
        // 一覧に入ったので、次の起動 (新しい ProjectFiles) でも開ける
        let next = ProjectFiles::new(Some(data.clone()));
        assert!(next.open_known(&src, 3).is_ok());
        std::fs::remove_file(&src).unwrap();
        let views = next.recent_views();
        assert!(!views[0].exists);
        let err = next.open_known(&src, 4).unwrap_err();
        assert!(err.contains("見つかりません"), "{err}");
        next.remove_recent(&src);
        assert!(next.recent_views().is_empty());
        assert!(ProjectFiles::new(Some(data)).recent_views().is_empty());
    }

    #[test]
    fn 保存していない変更が在るときだけ閉じるのを止める() {
        let mut doc = DocumentState::default();
        assert_eq!(doc.decide_close(), CloseDecision::Allow);
        doc.set_dirty(true);
        assert_eq!(doc.decide_close(), CloseDecision::AskUi);
        // 尋ねた結果「保存しない」を選んだら、次の閉じる (とアプリの終了) は止めない
        doc.confirm();
        assert_eq!(doc.decide_close(), CloseDecision::Allow);
        // また変更したら止める
        doc.set_dirty(true);
        assert_eq!(doc.decide_close(), CloseDecision::AskUi);
        doc.set_dirty(false);
        assert_eq!(doc.decide_close(), CloseDecision::Allow);
    }

    #[test]
    fn データ置き場が分からなければ扱わない() {
        let files = ProjectFiles::new(None);
        assert!(files.work_path("0123456789abcdef01234567").is_err());
        assert!(files.recent_views().is_empty());
    }
}
