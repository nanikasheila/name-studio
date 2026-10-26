//! ネームデータ（正本）: the project file of the name tool.
//!
//! A project holds pages with panels, lines (セリフ) and rough strokes, plus
//! story structure (scenes, characters, emotion values) for the overview
//! views. CSP files are imported from and exported to; this is the source of
//! truth.

pub mod model;
pub mod pdf;
pub mod series;
pub mod validate;
pub mod versions;

use std::path::Path;

pub use model::*;
pub use series::{SERIES_EXTENSION, SERIES_VERSION, Series, SeriesEpisode, SeriesShared};
pub use validate::validate;

/// File extension of project files.
pub const EXTENSION: &str = "namestudio";

/// Errors while loading or saving a project file.
#[derive(Debug)]
pub enum ProjectError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(Vec<String>),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Io(error) => write!(f, "{error}"),
            ProjectError::Json(error) => write!(f, "ファイルの形式が正しくありません: {error}"),
            ProjectError::Invalid(problems) => write!(f, "{}", problems.join(" / ")),
        }
    }
}

impl std::error::Error for ProjectError {}

impl Project {
    pub fn from_json(text: &str) -> Result<Self, ProjectError> {
        let project: Project = serde_json::from_str(text).map_err(ProjectError::Json)?;
        let problems = validate(&project);
        if problems.is_empty() {
            Ok(project)
        } else {
            Err(ProjectError::Invalid(problems))
        }
    }

    pub fn to_json(&self) -> Result<String, ProjectError> {
        let problems = validate(self);
        if !problems.is_empty() {
            return Err(ProjectError::Invalid(problems));
        }
        serde_json::to_string(self).map_err(ProjectError::Json)
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProjectError> {
        Self::from_json(&std::fs::read_to_string(path).map_err(ProjectError::Io)?)
    }

    /// The text of a project file, checked like [`Project::load`] but kept as
    /// it is: fields this side does not know (added by the app) stay.
    pub fn load_text(path: impl AsRef<Path>) -> Result<String, ProjectError> {
        let text = std::fs::read_to_string(path).map_err(ProjectError::Io)?;
        Self::from_json(&text)?;
        Ok(text)
    }

    /// Save `text` (the project as the app wrote it) after checking it like a
    /// loaded file; nothing is written when it has problems. The parsed project
    /// is returned for its title and pages.
    pub fn save_text(path: impl AsRef<Path>, text: &str) -> Result<Self, ProjectError> {
        let project = Self::from_json(text)?;
        write_through_temporary(path.as_ref(), text)?;
        Ok(project)
    }

    /// Save through a temporary file so a crash never leaves half a project.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ProjectError> {
        let path = path.as_ref();
        write_through_temporary(path, &self.to_json()?)
    }
}

pub(crate) fn write_through_temporary(path: &Path, text: &str) -> Result<(), ProjectError> {
    let temporary = path.with_extension(format!("{EXTENSION}.tmp"));
    std::fs::write(&temporary, text).map_err(ProjectError::Io)?;
    std::fs::rename(&temporary, path).map_err(ProjectError::Io)
}
