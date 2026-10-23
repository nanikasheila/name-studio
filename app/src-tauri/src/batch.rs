//! Writing a name out for CSP from the command line, without the window's dialogs:
//!
//! ```text
//! name-studio-app --export-csp <name.namestudio> --template <page.clip> --out <folder>
//!     [--work-template <work.cmc> --work-name <name>] [--story-index <n>] [--donor <sample.clip>]...
//!     [--report <file.json>]
//! ```
//!
//! The window opens, writes the pages and the work as the export dialog would
//! (CSP layers where it can), writes a report (JSON, by default
//! `<folder>/name-studio-export.json`) and closes; the exit code is 0 when the
//! written files read back as sent.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExport {
    pub project: String,
    pub template: String,
    pub out_dir: String,
    pub work_template: Option<String>,
    pub work_name: Option<String>,
    pub story_index: Option<i64>,
    /// 見本のページ: CSP pages to copy text and vector layers from.
    pub donors: Vec<String>,
    /// The rough as 下描き layers at half opacity (`--no-draft-rough` turns it off).
    pub draft_rough: bool,
    pub report: String,
}

/// The batch export asked for by these arguments (program name first), if any.
pub fn from_args(args: impl IntoIterator<Item = String>) -> Result<Option<BatchExport>, String> {
    let mut args = args.into_iter().skip(1);
    let mut project = None;
    let mut template = None;
    let mut out_dir = None;
    let mut work_template = None;
    let mut work_name = None;
    let mut story_index = None;
    let mut report = None;
    let mut donors = Vec::new();
    let mut draft_rough = true;
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} の後に値がありません"));
        match arg.as_str() {
            "--export-csp" => project = Some(value()?),
            "--template" => template = Some(value()?),
            "--out" => out_dir = Some(value()?),
            "--work-template" => work_template = Some(value()?),
            "--work-name" => work_name = Some(value()?),
            "--story-index" => {
                let text = value()?;
                story_index = Some(
                    text.parse()
                        .map_err(|_| format!("--story-index が数ではありません: {text}"))?,
                );
            }
            "--report" => report = Some(value()?),
            "--donor" => donors.push(value()?),
            "--no-draft-rough" => draft_rough = false,
            // Anything else (such as what the system adds) is left alone.
            _ => {}
        }
    }
    let Some(project) = project else {
        return Ok(None);
    };
    let template = template.ok_or("--template（ページのひな形 .clip）がありません")?;
    let out_dir = out_dir.ok_or("--out（書き出し先のフォルダー）がありません")?;
    let report = report.unwrap_or_else(|| {
        Path::new(&out_dir)
            .join("name-studio-export.json")
            .display()
            .to_string()
    });
    Ok(Some(BatchExport {
        project,
        template,
        out_dir,
        work_template,
        work_name,
        story_index,
        donors,
        draft_rough,
        report,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("name-studio-app")
            .chain(list.iter().copied())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn no_batch_without_the_flag() {
        assert_eq!(from_args(args(&[])), Ok(None));
        assert_eq!(from_args(args(&["--something"])), Ok(None));
    }

    #[test]
    fn reads_a_batch_export() {
        let batch = from_args(args(&[
            "--export-csp",
            "a.namestudio",
            "--template",
            "page.clip",
            "--out",
            "out",
            "--work-template",
            "w.cmc",
            "--work-name",
            "第1話",
            "--story-index",
            "1",
            "--donor",
            "sample.clip",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(batch.project, "a.namestudio");
        assert_eq!(batch.donors, vec!["sample.clip".to_owned()]);
        assert_eq!(batch.work_name.as_deref(), Some("第1話"));
        assert_eq!(batch.story_index, Some(1));
        assert!(batch.draft_rough);
        assert_eq!(
            batch.report,
            Path::new("out").join("name-studio-export.json").display().to_string()
        );
    }

    #[test]
    fn leaves_the_rough_as_it_is_when_asked() {
        let batch = from_args(args(&[
            "--export-csp",
            "a",
            "--template",
            "t",
            "--out",
            "o",
            "--no-draft-rough",
        ]))
        .unwrap()
        .unwrap();
        assert!(!batch.draft_rough);
    }

    #[test]
    fn says_what_is_missing() {
        assert!(
            from_args(args(&["--export-csp", "a.namestudio"]))
                .unwrap_err()
                .contains("--template")
        );
        assert!(from_args(args(&["--export-csp"])).is_err());
        assert!(
            from_args(args(&[
                "--export-csp",
                "a",
                "--template",
                "t",
                "--out",
                "o",
                "--story-index",
                "x"
            ]))
            .is_err()
        );
    }
}
