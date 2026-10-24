//! The name data is defined twice: in [`name_model::model`] and in the front
//! end (app/src/project.ts). The fixtures here are written by the front end's
//! `contract.test.ts` and hold every field it knows and every value of each
//! choice; nothing may be lost or changed when Rust reads and writes them.

use name_model::{
    BalloonShape, Binding, BrushKind, EraseMode, LineKind, PanelBorder, PanelEffect, PanelFill, Project, TailStyle,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const FULL_PROJECT: &str = include_str!("fixtures/full-project.json");
const CHOICES: &str = include_str!("fixtures/choices.json");

/// Where `written` differs from `read` (numbers compared as numbers: 1 and 1.0 are the same).
fn differences(path: &str, read: &Value, written: &Value, found: &mut Vec<String>) {
    match (read, written) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => differences(&format!("{path}.{key}"), value, other, found),
                    None => found.push(format!("{path}.{key}: dropped by Rust")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                found.push(format!("{path}.{key}: added by Rust"));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (value, other)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{index}]"), value, other, found);
            }
        }
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => {}
        _ if read == written => {}
        _ => found.push(format!("{path}: {read} became {written}")),
    }
}

#[test]
fn every_field_of_the_front_end_survives_rust() {
    let read: Value = serde_json::from_str(FULL_PROJECT).unwrap();
    let project: Project = serde_json::from_value(read.clone())
        .unwrap_or_else(|error| panic!("model.rs cannot read the front end's project: {error}"));
    let written = serde_json::to_value(&project).unwrap();
    let mut found = Vec::new();
    differences("project", &read, &written, &mut found);
    assert!(
        found.is_empty(),
        "model.rs and app/src/project.ts differ:\n{}",
        found.join("\n")
    );
}

fn check_choice<T: DeserializeOwned + Serialize>(name: &str, values: &Value, found: &mut Vec<String>) {
    for value in values[name]
        .as_array()
        .unwrap_or_else(|| panic!("no {name} in choices.json"))
    {
        match serde_json::from_value::<T>(value.clone()) {
            Ok(read) if serde_json::to_value(&read).unwrap() == *value => {}
            Ok(read) => found.push(format!(
                "{name}: {value} became {}",
                serde_json::to_value(&read).unwrap()
            )),
            Err(error) => found.push(format!("{name}: {value} is unknown to Rust ({error})")),
        }
    }
}

#[test]
fn every_choice_of_the_front_end_is_known_to_rust() {
    let values: Value = serde_json::from_str(CHOICES).unwrap();
    let mut found = Vec::new();
    check_choice::<Binding>("binding", &values, &mut found);
    check_choice::<LineKind>("lineKind", &values, &mut found);
    check_choice::<PanelBorder>("panelBorder", &values, &mut found);
    check_choice::<PanelFill>("panelFill", &values, &mut found);
    check_choice::<PanelEffect>("panelEffect", &values, &mut found);
    check_choice::<BalloonShape>("balloonShape", &values, &mut found);
    check_choice::<TailStyle>("tailStyle", &values, &mut found);
    check_choice::<BrushKind>("brushKind", &values, &mut found);
    check_choice::<EraseMode>("eraseMode", &values, &mut found);
    let checked = 9;
    assert_eq!(
        values.as_object().map(|choices| choices.len()),
        Some(checked),
        "a choice in choices.json is not checked here"
    );
    assert!(found.is_empty(), "{}", found.join("\n"));
}
