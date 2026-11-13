//! sfizz (SFZ サンプラー) を Rust から使うための薄い包み。
//!
//! sfizz の C API (`third_party/sfizz/src/sfizz.h`) のうち、使う関数だけを宣言する。
//! サンプルは頭の部分だけをメモリに置き、続きは sfizz が自分のスレッドでディスクから読む。

use std::ffi::{c_char, c_void, CString};
use std::fmt;
use std::path::Path;

#[allow(non_camel_case_types)]
type sfizz_synth_t = c_void;

extern "C" {
    fn sfizz_create_synth() -> *mut sfizz_synth_t;
    fn sfizz_free(synth: *mut sfizz_synth_t);
    fn sfizz_load_file(synth: *mut sfizz_synth_t, path: *const c_char) -> bool;
    fn sfizz_load_string(
        synth: *mut sfizz_synth_t,
        path: *const c_char,
        text: *const c_char,
    ) -> bool;
    fn sfizz_get_num_regions(synth: *mut sfizz_synth_t) -> i32;
    fn sfizz_get_num_active_voices(synth: *mut sfizz_synth_t) -> i32;
    fn sfizz_get_num_preloaded_samples(synth: *mut sfizz_synth_t) -> usize;
    fn sfizz_set_samples_per_block(synth: *mut sfizz_synth_t, samples_per_block: i32);
    fn sfizz_set_sample_rate(synth: *mut sfizz_synth_t, sample_rate: f32);
    fn sfizz_set_preload_size(synth: *mut sfizz_synth_t, preload_size: u32);
    fn sfizz_set_num_voices(synth: *mut sfizz_synth_t, num_voices: i32);
    fn sfizz_send_note_on(synth: *mut sfizz_synth_t, delay: i32, note: i32, velocity: i32);
    fn sfizz_send_note_off(synth: *mut sfizz_synth_t, delay: i32, note: i32, velocity: i32);
    fn sfizz_send_cc(synth: *mut sfizz_synth_t, delay: i32, cc: i32, value: i32);
    fn sfizz_all_sound_off(synth: *mut sfizz_synth_t);
    fn sfizz_enable_freewheeling(synth: *mut sfizz_synth_t);
    fn sfizz_disable_freewheeling(synth: *mut sfizz_synth_t);
    fn sfizz_render_block(
        synth: *mut sfizz_synth_t,
        channels: *mut *mut f32,
        num_channels: i32,
        num_frames: i32,
    );
}

/// SFZ を読めなかったときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadError {
    /// パスに NUL 文字が含まれていて C に渡せない
    InvalidPath,
    /// sfizz が読み込みに失敗した (ファイルが無い、書式が壊れている など)
    Failed(String),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::InvalidPath => write!(f, "パスに使えない文字が含まれている"),
            LoadError::Failed(p) => write!(f, "SFZ を読めなかった: {p}"),
        }
    }
}

impl std::error::Error for LoadError {}

/// SFZ の楽器 1 つぶんのサンプラー。
///
/// 1 つの値を同時に 2 つのスレッドから触ってはいけない (sfizz の約束)。
/// 音声スレッドへ移すことはできる (`Send`) が、共有はできない (`Sync` ではない)。
pub struct Sampler {
    raw: *mut sfizz_synth_t,
    max_block: usize,
}

// sfizz のシンセは、1 スレッドからだけ触る限りスレッドをまたいで移してよい。
unsafe impl Send for Sampler {}

impl Sampler {
    /// サンプラーを作る。
    ///
    /// * `sample_rate` - 出力のサンプリング周波数 (Hz)
    /// * `max_block` - 1 回の `render` で作る最大のフレーム数
    pub fn new(sample_rate: f32, max_block: usize) -> Self {
        assert!(max_block > 0, "max_block は 1 以上");
        let raw = unsafe { sfizz_create_synth() };
        assert!(!raw.is_null(), "sfizz のシンセを作れなかった");
        unsafe {
            sfizz_set_sample_rate(raw, sample_rate);
            sfizz_set_samples_per_block(raw, max_block as i32);
        }
        Sampler { raw, max_block }
    }

    /// SFZ ファイルを読み込む。前に読んだ楽器は置き換わる。
    pub fn load_file(&mut self, path: &Path) -> Result<(), LoadError> {
        let c =
            CString::new(path.to_string_lossy().as_bytes()).map_err(|_| LoadError::InvalidPath)?;
        if unsafe { sfizz_load_file(self.raw, c.as_ptr()) } {
            Ok(())
        } else {
            Err(LoadError::Failed(path.display().to_string()))
        }
    }

    /// SFZ の本文を文字列で読み込む。`virtual_path` はサンプルの相対パスを解決する基準になる
    /// (そのファイルが実在する必要は無い)。
    pub fn load_string(&mut self, virtual_path: &Path, text: &str) -> Result<(), LoadError> {
        let p = CString::new(virtual_path.to_string_lossy().as_bytes())
            .map_err(|_| LoadError::InvalidPath)?;
        let t = CString::new(text).map_err(|_| LoadError::InvalidPath)?;
        if unsafe { sfizz_load_string(self.raw, p.as_ptr(), t.as_ptr()) } {
            Ok(())
        } else {
            Err(LoadError::Failed(virtual_path.display().to_string()))
        }
    }

    /// 読み込んだ楽器の region (鳴らし分けの単位) の数。
    pub fn num_regions(&self) -> usize {
        unsafe { sfizz_get_num_regions(self.raw) }.max(0) as usize
    }

    /// いま鳴っている声の数。
    pub fn active_voices(&self) -> usize {
        unsafe { sfizz_get_num_active_voices(self.raw) }.max(0) as usize
    }

    /// メモリに頭を置いているサンプルの数。
    pub fn preloaded_samples(&self) -> usize {
        unsafe { sfizz_get_num_preloaded_samples(self.raw) }
    }

    /// サンプルの頭をメモリに置く長さ (フレーム数)。読み込みの前に呼ぶ。
    ///
    /// ノートを鳴らしたブロックの中は頭だけで鳴らすので、`max_block` より十分長くする
    /// (音を上げて鳴らすと速く読み進むので、その倍率ぶんも要る)。足りないと、声は
    /// そこで終わる。sfizz の既定は 8192。
    pub fn set_preload_size(&mut self, frames: u32) {
        unsafe { sfizz_set_preload_size(self.raw, frames) }
    }

    /// 同時に鳴らせる声の上限。
    pub fn set_num_voices(&mut self, voices: usize) {
        unsafe { sfizz_set_num_voices(self.raw, voices as i32) }
    }

    /// ノートを鳴らす。`delay` は次の `render` のブロックの先頭からのフレーム数。
    pub fn note_on(&mut self, delay: usize, note: u8, velocity: u8) {
        unsafe {
            sfizz_send_note_on(
                self.raw,
                delay as i32,
                note as i32,
                velocity.clamp(1, 127) as i32,
            )
        }
    }

    /// ノートを離す。`delay` は `note_on` と同じ。
    pub fn note_off(&mut self, delay: usize, note: u8) {
        unsafe { sfizz_send_note_off(self.raw, delay as i32, note as i32, 0) }
    }

    /// コントロールチェンジ (例: 64 = サステインペダル)。
    pub fn cc(&mut self, delay: usize, cc: u8, value: u8) {
        unsafe { sfizz_send_cc(self.raw, delay as i32, cc as i32, value.min(127) as i32) }
    }

    /// 鳴っている音をすべて止める。
    pub fn all_sound_off(&mut self) {
        unsafe { sfizz_all_sound_off(self.raw) }
    }

    /// オフライン描画のモード (sfizz の freewheeling) を切り替える。
    ///
    /// 有効にすると、`render` のたびにディスクからの読み込みが終わるのを待つ
    /// (実時間より速く描画しても、サンプルの続きが欠けない)。補間の品質も
    /// オフライン用の高い設定になる。リアルタイムの再生では無効にしておく
    /// (待つと音が途切れる)。
    pub fn set_offline(&mut self, offline: bool) {
        unsafe {
            if offline {
                sfizz_enable_freewheeling(self.raw)
            } else {
                sfizz_disable_freewheeling(self.raw)
            }
        }
    }

    /// 次のブロックの音を作る。`left` と `right` は同じ長さで、`max_block` 以下。
    /// 中身は上書きされる。
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右の長さが違う");
        assert!(left.len() <= self.max_block, "max_block を超えた");
        let mut ch = [left.as_mut_ptr(), right.as_mut_ptr()];
        unsafe { sfizz_render_block(self.raw, ch.as_mut_ptr(), 2, left.len() as i32) }
    }

    /// 1 回の `render` で作れる最大のフレーム数。
    pub fn max_block(&self) -> usize {
        self.max_block
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        unsafe { sfizz_free(self.raw) }
    }
}
