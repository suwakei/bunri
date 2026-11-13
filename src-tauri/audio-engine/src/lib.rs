//! bunri の音のエンジン。
//!
//! いまは SFZ サンプラー (sfizz) と、ノートの並びをオフラインで音にする部分だけを持つ。
//! 設計は `docs/instrument-engine-design.md`。

pub mod render;
pub mod sampler;

pub use render::{render_notes, Note};
pub use sampler::{LoadError, Sampler};
