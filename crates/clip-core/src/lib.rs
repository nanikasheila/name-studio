//! Read and write CLIP STUDIO PAINT files (.clip / .cmc) for the name tool.
//!
//! Ported from the Python reference implementation in
//! `name_splitter/csp` of csp-name-splitter; the format notes live in
//! `docs/formats/csp-file-format.md` there. Files are only read here: CSP
//! itself is never touched.

mod bytes;
pub mod clip;
pub mod cmc;
pub mod container;
pub mod error;
pub mod inspect;
pub mod offscreen;
mod sql;
pub mod text;
pub mod vector;

pub use clip::{ClipCanvas, ClipDocument, ClipLayer, LayerKind};
pub use cmc::{CmcPage, CmcProject};
pub use error::{CspError, Result};
pub use offscreen::RgbaImage;
pub use sql::Row;
