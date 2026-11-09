//! What an AI changes with the app's 変更の案 (app/src/assist.ts, also the
//! Skills' command line) must open here: `fixtures/assist-made.json` is a
//! name made by every kind of operation, written by `assist.test.ts`.

use name_model::Project;

const MADE: &str = include_str!("fixtures/assist-made.json");

#[test]
fn a_name_changed_by_the_operations_opens() {
    let project = Project::from_json(MADE).unwrap_or_else(|error| panic!("the operations made a name Rust refuses: {error}"));
    assert!(project.pages.len() >= 5);
    assert!(project.characters.iter().any(|character| character.name == "先生"));
    assert!(project.pages.iter().any(|page| page.stickies.iter().any(|sticky| sticky.link.is_some())));
}

#[test]
fn the_operations_write_no_field_rust_does_not_know() {
    assert_eq!(Project::unknown_fields(MADE).unwrap(), Vec::<String>::new());
}
