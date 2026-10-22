//! ネームデータ（正本）: the project file of the name tool.
//!
//! A project holds pages with panels, lines (セリフ) and rough strokes, plus
//! story structure (scenes, characters, emotion values) for the overview
//! views. CSP files are imported from and exported to; this is the source of
//! truth.

pub mod import;
pub mod model;
pub mod validate;

use std::path::Path;

pub use model::*;
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
        serde_json::to_string_pretty(self).map_err(ProjectError::Json)
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProjectError> {
        Self::from_json(&std::fs::read_to_string(path).map_err(ProjectError::Io)?)
    }

    /// Save through a temporary file so a crash never leaves half a project.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ProjectError> {
        let path = path.as_ref();
        let text = self.to_json()?;
        let temporary = path.with_extension(format!("{EXTENSION}.tmp"));
        std::fs::write(&temporary, text).map_err(ProjectError::Io)?;
        std::fs::rename(&temporary, path).map_err(ProjectError::Io)
    }
}
