//! Read and write CLIP STUDIO PAINT files (.clip / .cmc) for the name tool.
//!
//! The format itself (container, database, pixel blocks, text, vectors) is
//! csp-format's, whose `docs/spec` is where it is written down; this crate
//! holds the name tool's own rules on top of it (which layers a page gets,
//! page frames, spreads, the self-check). It began as a port of the Python
//! reference (`name_splitter/csp` of csp-name-splitter). Input files are only
//! read: CSP itself is never touched; pages and works are written as new files.

pub mod clip;
pub mod cmc;
pub mod error;
#[cfg(feature = "fixtures")]
pub mod fixtures;
pub mod import;
pub mod inspect;
pub mod layout;
pub mod offscreen;
pub mod plan;
pub mod raster;
pub mod subtool;
pub mod text;
pub mod vector;
pub mod write;

pub use clip::{ClipCanvas, ClipDocument, ClipLayer, LayerKind};
pub use cmc::{CmcPage, CmcProject};
pub use csp_format::database::Row;
pub use error::{CspError, Result};
pub use offscreen::RgbaImage;
