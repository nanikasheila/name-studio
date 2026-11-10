//! The app's commands, and the shapes they take and give, as TypeScript.
//!
//! The front end calls the Rust side by name with JSON (`call` in
//! app/src/backend.ts). What a command is called, what its arguments are
//! called and what comes back used to be written down a second time by hand;
//! here it is read from the Rust source instead, so the two cannot drift
//! apart: `cargo run -p ipc-types` writes app/src/generated/ipc.ts, and a
//! test fails while that file is behind.
//!
//! The source is read as text (with `syn`), not compiled: every
//! `#[tauri::command]` in app/src-tauri, in the order `generate_handler!`
//! lists them, and every struct and enum they mention, wherever in this
//! repository it is defined. What serde does with a type is followed for the
//! attributes used here (`rename_all`, `default`, `flatten`, `skip…`,
//! `untagged`, `tag`); one this does not know is an error, never a guess.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use syn::{
    Attribute, Expr, Fields, FnArg, GenericArgument, Item, ItemEnum, ItemFn, ItemStruct, Lit, Pat, PathArguments,
    ReturnType, Type, UseTree,
};

/// The file written, from the repository's root.
pub const OUTPUT: &str = "app/src/generated/ipc.ts";

/// Where the commands are, and where the types they mention may be.
const SOURCES: &[&str] = &["app/src-tauri/src", "crates/clip-core/src", "crates/name-model/src"];

/// A crate of another repository whose types the commands take as they are
/// (the page settings a CSP page is made from). Its source is read where
/// cargo keeps it, at the version Cargo.lock says.
const FOREIGN: &str = "csp-format";

/// The crates of [`SOURCES`] and [`FOREIGN`] as `use` names them, in that order.
const CRATES: &[&str] = &["name_studio_app", "clip_core", "name_model", "csp_format"];

/// Types the TypeScript side keeps by hand, and the module that has them
/// (from app/src/generated): the name data, which its own test checks against
/// the Rust types (crates/name-model/tests/typescript.rs).
const EXTERNAL: &[(&str, &str)] = &[
    ("Project", "../model"),
    ("Series", "../model"),
    ("CspToolData", "../model"),
];

/// Where the Rust side passes JSON on as it is, or takes plain text, but the
/// front end knows more: a command's result (`command`), one of its
/// arguments (`command.argument`) or a field (`Type.field`), and its type in
/// TypeScript.
const OVERRIDES: &[(&str, &str)] = &[
    ("load_project", "Project"),
    ("load_version", "Project"),
    ("load_series", "Series"),
    ("Recovery.project", "Project"),
    (
        "AiEvent.kind",
        r#""session" | "delta" | "text" | "tool" | "done" | "error""#,
    ),
    ("ChatMessage.role", r#""system" | "user" | "assistant""#),
    ("ai_install_skill.target", r#""claude" | "codex" | "folder""#),
    ("check_update.channel", r#""stable" | "beta""#),
];

/// Shapes sent to the front end as events, not as a command's result.
const EVENTS: &[&str] = &["AiEvent"];

/// Arguments Tauri fills in itself: not part of what the front end sends.
const INJECTED: &[&str] = &["AppHandle", "State", "Window", "Webview", "WebviewWindow"];

/// One source file: which of [`SOURCES`] it is in, its path in there, and its text.
pub struct SourceFile {
    pub source: usize,
    pub path: PathBuf,
    pub text: String,
}

/// The TypeScript for the commands under `root` (the repository).
pub fn generate(root: &Path) -> Result<String, String> {
    let mut dirs: Vec<PathBuf> = SOURCES.iter().map(|dir| root.join(dir)).collect();
    dirs.push(foreign_source(root)?);
    let mut files = Vec::new();
    for (source, dir) in dirs.iter().enumerate() {
        let mut paths = Vec::new();
        rust_files(dir, &mut paths)?;
        paths.sort();
        for path in paths {
            let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
            let path = path.strip_prefix(dir).unwrap_or(&path).to_owned();
            files.push(SourceFile { source, path, text });
        }
    }
    render(&files)
}

/// The `src` of [`FOREIGN`] as this workspace builds it (`cargo metadata` knows where it was fetched to).
fn foreign_source(root: &Path) -> Result<PathBuf, String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = std::process::Command::new(cargo)
        .args(["metadata", "--format-version", "1"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("cargo metadata: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| format!("cargo metadata: {error}"))?;
    let manifest = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|package| package["name"] == FOREIGN)
        .and_then(|package| package["manifest_path"].as_str())
        .ok_or_else(|| format!("cargo metadata does not list {FOREIGN}"))?;
    Ok(Path::new(manifest).with_file_name("src"))
}

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|error| format!("{}: {error}", dir.display()))?.path();
        if path.is_dir() {
            rust_files(&path, found)?;
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
    Ok(())
}

/// The TypeScript for the commands in `files` (the first of [`SOURCES`] holds lib.rs, which lists them).
pub fn render(files: &[SourceFile]) -> Result<String, String> {
    let sources = Sources::read(files)?;
    let mut generator = Generator::new(&sources);
    let commands = generator.commands()?;
    for event in EVENTS {
        if sources.defs.contains_key(*event) {
            let place = Place {
                source: 0,
                file: PathBuf::new(),
            };
            generator.named(event, None, &place, Direction::Out)?;
        }
    }
    generator.close()?;
    let types = generator.types()?;
    Ok(generator.page(&commands, &types))
}

/// Where a type is written, to find the types it mentions: the same file first, then the same crate.
#[derive(Clone, PartialEq, Eq)]
struct Place {
    source: usize,
    file: PathBuf,
}

impl Place {
    fn name(&self) -> String {
        format!(
            "{}/{}",
            SOURCES.get(self.source).copied().unwrap_or(FOREIGN),
            self.file.display()
        )
        .replace('\\', "/")
    }
}

enum Shape {
    Struct(ItemStruct),
    Enum(ItemEnum),
    Alias(Type),
}

struct Definition {
    place: Place,
    shape: Shape,
}

struct Command {
    place: Place,
    function: ItemFn,
}

/// What a file's `use` lines bring in.
#[derive(Default)]
struct Uses {
    /// A name, with the crate it comes from (when it is one read here) and what it is called there.
    names: BTreeMap<String, (Option<usize>, String)>,
    /// Crates everything is brought in from (`use name_model::*`).
    globs: Vec<usize>,
}

impl Uses {
    fn take(&mut self, tree: &UseTree, first: Option<&str>, here: usize) {
        let source = |first: &str| match first {
            "crate" | "self" | "super" => Some(here),
            other => CRATES.iter().position(|name| *name == other),
        };
        match tree {
            UseTree::Path(path) => {
                let ident = path.ident.to_string();
                self.take(&path.tree, Some(first.unwrap_or(&ident)), here);
            }
            UseTree::Name(name) => {
                let ident = name.ident.to_string();
                self.names
                    .insert(ident.clone(), (source(first.unwrap_or(&ident)), ident));
            }
            UseTree::Rename(rename) => {
                let ident = rename.ident.to_string();
                self.names
                    .insert(rename.rename.to_string(), (source(first.unwrap_or(&ident)), ident));
            }
            UseTree::Glob(_) => self.globs.extend(first.and_then(source)),
            UseTree::Group(group) => {
                for tree in &group.items {
                    self.take(tree, first, here);
                }
            }
        }
    }
}

#[derive(Default)]
struct Sources {
    defs: BTreeMap<String, Vec<Definition>>,
    uses: BTreeMap<(usize, PathBuf), Uses>,
    commands: BTreeMap<String, Command>,
    /// The commands `generate_handler!` lists, in its order.
    registered: Vec<String>,
}

impl Sources {
    fn read(files: &[SourceFile]) -> Result<Self, String> {
        let mut sources = Self::default();
        for file in files {
            let place = Place {
                source: file.source,
                file: file.path.clone(),
            };
            let parsed = syn::parse_file(&file.text).map_err(|error| format!("{}: {error}", place.name()))?;
            sources.take(&place, parsed.items);
            if file.source == 0
                && let Some(list) = handler_list(&file.text)
            {
                sources.registered = list;
            }
        }
        if sources.registered.is_empty() {
            return Err("no generate_handler![…] found in the app's source".into());
        }
        Ok(sources)
    }

    fn take(&mut self, place: &Place, items: Vec<Item>) {
        for item in items {
            let (name, shape) = match item {
                Item::Struct(item) => (item.ident.to_string(), Shape::Struct(item)),
                Item::Enum(item) => (item.ident.to_string(), Shape::Enum(item)),
                Item::Type(item) => (item.ident.to_string(), Shape::Alias(*item.ty)),
                Item::Fn(function) => {
                    if place.source == 0 && function.attrs.iter().any(is_command) {
                        let place = place.clone();
                        self.commands
                            .insert(function.sig.ident.to_string(), Command { place, function });
                    }
                    continue;
                }
                Item::Use(item) => {
                    self.uses.entry((place.source, place.file.clone())).or_default().take(
                        &item.tree,
                        None,
                        place.source,
                    );
                    continue;
                }
                Item::Mod(module) => {
                    // Tests have types of their own, often named like the real ones.
                    if !module.attrs.iter().any(is_test)
                        && let Some((_, items)) = module.content
                    {
                        self.take(place, items);
                    }
                    continue;
                }
                _ => continue,
            };
            let place = place.clone();
            self.defs.entry(name).or_default().push(Definition { place, shape });
        }
    }

    /// The crate a type's path points to, and its name there: `a::b::Name` by its
    /// first part, a bare `Name` by the `use` that brought it in.
    fn hint(&self, path: &syn::Path, from: &Place) -> (Option<usize>, String) {
        let name = path
            .segments
            .last()
            .map(|segment| segment.ident.to_string())
            .unwrap_or_default();
        let first = path
            .segments
            .first()
            .map(|segment| segment.ident.to_string())
            .unwrap_or_default();
        let uses = self.uses.get(&(from.source, from.file.clone()));
        if path.segments.len() > 1 {
            let direct = match first.as_str() {
                "crate" | "self" | "super" => Some(from.source),
                other => CRATES.iter().position(|name| *name == other),
            };
            let source = direct.or_else(|| {
                uses.and_then(|uses| uses.names.get(&first))
                    .and_then(|(source, _)| *source)
            });
            return (source, name);
        }
        match uses.and_then(|uses| uses.names.get(&name)) {
            Some((source, original)) => (*source, original.clone()),
            None => (None, name),
        }
    }

    /// The definition of `name` as `from` means it: in the crate `hint` says,
    /// else in the same file, the same crate, a crate brought in whole, or
    /// the only one there is.
    fn find(&self, name: &str, hint: Option<usize>, from: &Place) -> Result<&Definition, String> {
        let all = self.defs.get(name).map(Vec::as_slice).unwrap_or_default();
        let ambiguous = || {
            Err(format!(
                "{name} (used in {}) could be any of {}",
                from.name(),
                all.iter()
                    .map(|definition| definition.place.name())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        };
        if hint.is_none_or(|hint| hint == from.source)
            && let Some(here) = all.iter().find(|definition| definition.place == *from)
        {
            return Ok(here);
        }
        let mut tried = vec![hint.unwrap_or(from.source)];
        if hint.is_none()
            && let Some(uses) = self.uses.get(&(from.source, from.file.clone()))
        {
            tried.extend(&uses.globs);
        }
        for source in tried {
            let there: Vec<_> = all
                .iter()
                .filter(|definition| definition.place.source == source)
                .collect();
            match there.as_slice() {
                [] => {}
                [one] => return Ok(one),
                _ => return ambiguous(),
            }
        }
        match all {
            [one] => Ok(one),
            [] => Err(format!(
                "{name} (used in {}) is not a type of this repository: name it in EXTERNAL or OVERRIDES (crates/ipc-types)",
                from.name()
            )),
            _ => ambiguous(),
        }
    }
}

fn is_command(attribute: &Attribute) -> bool {
    let path = attribute.path();
    path.segments.last().is_some_and(|last| last.ident == "command") && path.segments.len() <= 2
}

fn is_test(attribute: &Attribute) -> bool {
    attribute.path().is_ident("cfg") && attribute.parse_args::<syn::Ident>().is_ok_and(|ident| ident == "test")
}

/// The names in `generate_handler![…]`, without their modules.
fn handler_list(text: &str) -> Option<Vec<String>> {
    let start = text.find("generate_handler![")? + "generate_handler![".len();
    let end = start + text[start..].find(']')?;
    let names = text[start..end]
        .split(',')
        .map(|entry| entry.trim().rsplit("::").next().unwrap_or_default().trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    Some(names)
}

/// Which way a shape travels: what serde leaves out or fills in differs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    /// From the front end (deserialized).
    In,
    /// To the front end (serialized).
    Out,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Travels {
    taken: bool,
    given: bool,
}

struct CommandEntry {
    name: String,
    file: String,
    docs: Vec<String>,
    takes: String,
    gives: String,
}

struct Generator<'a> {
    sources: &'a Sources,
    /// The types to write, by name, with where each is defined and which way it travels.
    used: BTreeMap<String, (Place, Travels)>,
    /// Types whose fields are still to be followed.
    queue: Vec<(String, Direction)>,
    imports: BTreeMap<&'static str, BTreeSet<&'static str>>,
}

impl<'a> Generator<'a> {
    fn new(sources: &'a Sources) -> Self {
        Self {
            sources,
            used: BTreeMap::new(),
            queue: Vec::new(),
            imports: BTreeMap::new(),
        }
    }

    fn commands(&mut self) -> Result<Vec<CommandEntry>, String> {
        let sources = self.sources;
        if let Some(missing) = sources.commands.keys().find(|name| !sources.registered.contains(name)) {
            return Err(format!(
                "{missing} is a #[tauri::command] that generate_handler! does not list"
            ));
        }
        let mut entries = Vec::new();
        for name in &sources.registered {
            let command = sources
                .commands
                .get(name)
                .ok_or_else(|| format!("generate_handler! lists {name}, but no #[tauri::command] fn has that name"))?;
            entries.push(self.command(name, command)?);
        }
        Ok(entries)
    }

    fn command(&mut self, name: &str, command: &Command) -> Result<CommandEntry, String> {
        let place = &command.place;
        let signature = &command.function.sig;
        let mut arguments = Vec::new();
        let mut raw = false;
        for input in &signature.inputs {
            let FnArg::Typed(argument) = input else {
                return Err(format!("{name}: a command cannot take self"));
            };
            let last = last_segment(&argument.ty);
            if last.as_deref().is_some_and(|last| INJECTED.contains(&last)) {
                continue;
            }
            if last.as_deref() == Some("Request") {
                raw = true;
                continue;
            }
            let Pat::Ident(pattern) = &*argument.pat else {
                return Err(format!("{name}: an argument without a plain name"));
            };
            let rust = plain(&pattern.ident);
            let ts = match self.overridden(&format!("{name}.{rust}"), place)? {
                Some(ts) => ts,
                None => self.ts(&argument.ty, place, Direction::In)?,
            };
            // Tauri takes a missing argument for `None`.
            let optional = if option_inner(&argument.ty).is_some() { "?" } else { "" };
            arguments.push(format!("{}{optional}: {ts}", renamed(&rust, Some("camelCase"), false)?));
        }
        let takes = match (raw, arguments.is_empty()) {
            (true, true) => "RawBody".to_owned(),
            (true, false) => return Err(format!("{name}: a raw request body and named arguments together")),
            (false, true) => "void".to_owned(),
            (false, false) => format!("{{ {} }}", arguments.join("; ")),
        };
        let gives = match &signature.output {
            ReturnType::Default => "void".to_owned(),
            ReturnType::Type(_, ty) => {
                let ty = result_inner(ty).unwrap_or(ty);
                if let Some(ts) = self.overridden(name, place)? {
                    ts
                } else if matches!(ty, Type::Tuple(tuple) if tuple.elems.is_empty()) {
                    "void".to_owned()
                } else if last_segment(ty).as_deref() == Some("Response") {
                    "ArrayBuffer".to_owned()
                } else {
                    self.ts(ty, place, Direction::Out)?
                }
            }
        };
        Ok(CommandEntry {
            name: name.to_owned(),
            file: place.file.display().to_string().replace('\\', "/"),
            docs: docs(&command.function.attrs),
            takes,
            gives,
        })
    }

    /// What OVERRIDES says `key` is, with the types it names brought in.
    fn overridden(&mut self, key: &str, place: &Place) -> Result<Option<String>, String> {
        let Some((_, ts)) = OVERRIDES.iter().find(|(name, _)| *name == key) else {
            return Ok(None);
        };
        let mut quoted = false;
        let mut word = String::new();
        for character in ts.chars().chain([' ']) {
            if character == '"' {
                quoted = !quoted;
            }
            if !quoted && (character.is_alphanumeric() || character == '_') {
                word.push(character);
                continue;
            }
            let name = std::mem::take(&mut word);
            if name.chars().next().is_some_and(char::is_uppercase)
                && (external(&name).is_some() || self.sources.defs.contains_key(&name))
            {
                self.named(&name, None, place, Direction::Out)?;
            }
        }
        Ok(Some((*ts).to_owned()))
    }

    /// A Rust type as TypeScript; the named types in it are noted, to write them too.
    fn ts(&mut self, ty: &Type, place: &Place, direction: Direction) -> Result<String, String> {
        match ty {
            Type::Reference(reference) => self.ts(&reference.elem, place, direction),
            Type::Paren(inner) => self.ts(&inner.elem, place, direction),
            Type::Group(inner) => self.ts(&inner.elem, place, direction),
            Type::Slice(slice) => Ok(list(&self.ts(&slice.elem, place, direction)?)),
            Type::Tuple(tuple) if tuple.elems.is_empty() => Ok("null".to_owned()),
            Type::Tuple(tuple) => {
                let parts = tuple
                    .elems
                    .iter()
                    .map(|part| self.ts(part, place, direction))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(format!("[{}]", parts.join(", ")))
            }
            Type::Array(array) => {
                let element = self.ts(&array.elem, place, direction)?;
                match array_length(&array.len) {
                    Some(length) if length <= 8 => Ok(format!("[{}]", vec![element; length].join(", "))),
                    _ => Ok(list(&element)),
                }
            }
            Type::Path(path) => {
                let Some(segment) = path.path.segments.last() else {
                    return Err(format!("an empty type in {}", place.name()));
                };
                let name = segment.ident.to_string();
                let arguments: Vec<&Type> = match &segment.arguments {
                    PathArguments::AngleBracketed(list) => list
                        .args
                        .iter()
                        .filter_map(|argument| match argument {
                            GenericArgument::Type(ty) => Some(ty),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                let argument = |index: usize, generator: &mut Self| match arguments.get(index) {
                    Some(ty) => generator.ts(ty, place, direction),
                    None => Err(format!("{name} without its type in {}", place.name())),
                };
                match name.as_str() {
                    "String" | "str" | "PathBuf" | "Path" | "OsString" | "char" => Ok("string".to_owned()),
                    "bool" => Ok("boolean".to_owned()),
                    "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" | "f32" | "f64"
                    | "ResourceId" => Ok("number".to_owned()),
                    "Option" => Ok(union(&[argument(0, self)?, "null".to_owned()])),
                    "Vec" | "VecDeque" | "BTreeSet" | "HashSet" => Ok(list(&argument(0, self)?)),
                    "HashMap" | "BTreeMap" => Ok(format!("Record<string, {}>", argument(1, self)?)),
                    "Box" | "Arc" | "Rc" | "Cow" => argument(0, self),
                    // JSON passed on as it is: OVERRIDES says what it is where the front end knows.
                    "Value" | "RawValue" => Ok("unknown".to_owned()),
                    _ => {
                        let (hint, name) = self.sources.hint(&path.path, place);
                        self.named(&name, hint, place, direction)
                    }
                }
            }
            _ => Err(format!(
                "a type this does not know how to write as TypeScript, in {}",
                place.name()
            )),
        }
    }

    /// A struct, enum or alias by name: noted to be written, and its name in TypeScript.
    fn named(&mut self, name: &str, hint: Option<usize>, from: &Place, direction: Direction) -> Result<String, String> {
        if let Some(module) = external(name) {
            let (name, _) = EXTERNAL
                .iter()
                .find(|(known, _)| *known == name)
                .expect("it is external");
            self.imports.entry(module).or_default().insert(name);
            return Ok((*name).to_owned());
        }
        let sources = self.sources;
        let definition = sources.find(name, hint, from)?;
        if let Shape::Alias(ty) = &definition.shape {
            return self.ts(ty, &definition.place, direction);
        }
        let (place, travels) = self
            .used
            .entry(name.to_owned())
            .or_insert_with(|| (definition.place.clone(), Travels::default()));
        if *place != definition.place {
            return Err(format!(
                "two types named {name} are sent to the front end ({} and {}): give one another name",
                place.name(),
                definition.place.name()
            ));
        }
        let seen = match direction {
            Direction::In => &mut travels.taken,
            Direction::Out => &mut travels.given,
        };
        if !*seen {
            *seen = true;
            self.queue.push((name.to_owned(), direction));
        }
        Ok(name.to_owned())
    }

    /// Follow the fields of every type noted, and of the types those mention.
    fn close(&mut self) -> Result<(), String> {
        while let Some((name, direction)) = self.queue.pop() {
            let travels = match direction {
                Direction::In => Travels {
                    taken: true,
                    given: false,
                },
                Direction::Out => Travels {
                    taken: false,
                    given: true,
                },
            };
            self.declaration(&name, travels)?;
        }
        Ok(())
    }

    fn types(&mut self) -> Result<Vec<String>, String> {
        let used: Vec<(String, Travels)> = self
            .used
            .iter()
            .map(|(name, (_, travels))| (name.clone(), *travels))
            .collect();
        used.into_iter()
            .map(|(name, travels)| self.declaration(&name, travels))
            .collect()
    }

    /// `export interface Name { … }` or `export type Name = …;`, with its documentation.
    fn declaration(&mut self, name: &str, travels: Travels) -> Result<String, String> {
        let sources = self.sources;
        let place = self
            .used
            .get(name)
            .map(|(place, _)| place.clone())
            .ok_or_else(|| format!("{name} is not used"))?;
        let definition = sources.find(name, None, &place)?;
        let mut text = comment(
            &docs(match &definition.shape {
                Shape::Struct(item) => &item.attrs,
                Shape::Enum(item) => &item.attrs,
                Shape::Alias(_) => &[],
            }),
            "",
        );
        match &definition.shape {
            Shape::Struct(item) => {
                let container = Serde::of(&item.attrs, name)?;
                match &item.fields {
                    Fields::Named(fields) => {
                        let (lines, extends) = self.fields(
                            name,
                            &fields.named,
                            &container,
                            container.rename_all.as_deref(),
                            travels,
                            &place,
                        )?;
                        let extends = if extends.is_empty() {
                            String::new()
                        } else {
                            format!(" extends {}", extends.join(", "))
                        };
                        let _ = writeln!(text, "export interface {name}{extends} {{");
                        for line in lines {
                            text.push_str(&line);
                        }
                        text.push_str("}\n");
                    }
                    Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
                        let ts = self.field_type(name, None, &fields.unnamed[0].ty, &place, travels)?;
                        let _ = writeln!(text, "export type {name} = {ts};");
                    }
                    _ => {
                        return Err(format!(
                            "{name}: a struct without named fields cannot be written as TypeScript"
                        ));
                    }
                }
            }
            Shape::Enum(item) => {
                let variants = self.variants(name, item, travels, &place)?;
                let _ = writeln!(text, "export type {name} = {};", union(&variants));
            }
            Shape::Alias(_) => return Err(format!("{name}: an alias is written as what it stands for")),
        }
        Ok(text)
    }

    /// A type in both directions it travels (the TypeScript is the same; the types it names are noted for both).
    fn field_type(
        &mut self,
        owner: &str,
        field: Option<&str>,
        ty: &Type,
        place: &Place,
        travels: Travels,
    ) -> Result<String, String> {
        if let Some(field) = field
            && let Some(ts) = self.overridden(&format!("{owner}.{field}"), place)?
        {
            return Ok(ts);
        }
        let mut ts = String::new();
        if travels.taken {
            ts = self.ts(ty, place, Direction::In)?;
        }
        if travels.given {
            ts = self.ts(ty, place, Direction::Out)?;
        }
        Ok(ts)
    }

    /// The lines of an interface's body, and the types it extends (flattened fields).
    fn fields(
        &mut self,
        owner: &str,
        fields: &syn::punctuated::Punctuated<syn::Field, syn::Token![,]>,
        container: &Serde,
        rename_all: Option<&str>,
        travels: Travels,
        place: &Place,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let mut lines = Vec::new();
        let mut extends = Vec::new();
        for field in fields {
            let rust = plain(field.ident.as_ref().expect("a named field"));
            let serde = Serde::of(&field.attrs, &format!("{owner}.{rust}"))?;
            let left_out = serde.skip
                || (serde.skip_serializing && !travels.taken)
                || (serde.skip_deserializing && !travels.given);
            if left_out {
                continue;
            }
            if serde.custom && !OVERRIDES.iter().any(|(key, _)| *key == format!("{owner}.{rust}")) {
                return Err(format!(
                    "{owner}.{rust} is written by a function of its own (serde with): say what it is in OVERRIDES"
                ));
            }
            let ts = self.field_type(owner, Some(&rust), &field.ty, place, travels)?;
            if serde.flatten {
                extends.push(ts);
                continue;
            }
            let key = match &serde.rename {
                Some(name) => name.clone(),
                None => renamed(&rust, rename_all, false)?,
            };
            // Left out on the way in: serde fills it in. Left out on the way out: skip_serializing_if.
            let optional = (travels.taken && (serde.default || container.default || option_inner(&field.ty).is_some()))
                || (travels.given && (serde.skip_if || serde.skip_serializing || serde.skip_deserializing));
            lines.push(format!(
                "{}  {}{}: {ts};\n",
                comment(&docs(&field.attrs), "  "),
                property(&key),
                if optional { "?" } else { "" }
            ));
        }
        Ok((lines, extends))
    }

    /// An enum's variants as the members of a union.
    fn variants(
        &mut self,
        name: &str,
        item: &ItemEnum,
        travels: Travels,
        place: &Place,
    ) -> Result<Vec<String>, String> {
        let container = Serde::of(&item.attrs, name)?;
        let mut members = Vec::new();
        for variant in &item.variants {
            let rust = plain(&variant.ident);
            let serde = Serde::of(&variant.attrs, &format!("{name}::{rust}"))?;
            if serde.skip {
                continue;
            }
            let tag = match &serde.rename {
                Some(tag) => tag.clone(),
                None => renamed(&rust, container.rename_all.as_deref(), true)?,
            };
            let body = match &variant.fields {
                Fields::Unit => None,
                Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
                    Some(self.field_type(name, None, &fields.unnamed[0].ty, place, travels)?)
                }
                Fields::Unnamed(fields) => {
                    let parts = fields
                        .unnamed
                        .iter()
                        .map(|field| self.field_type(name, None, &field.ty, place, travels))
                        .collect::<Result<Vec<_>, _>>()?;
                    Some(format!("[{}]", parts.join(", ")))
                }
                Fields::Named(fields) => {
                    let rule = serde.rename_all.as_deref().or(container.rename_all_fields.as_deref());
                    let (lines, extends) =
                        self.fields(&format!("{name}::{rust}"), &fields.named, &serde, rule, travels, place)?;
                    if !extends.is_empty() {
                        return Err(format!("{name}::{rust}: flatten in a variant is not written yet"));
                    }
                    let inline: Vec<String> = lines
                        .iter()
                        .map(|line| line.trim().trim_end_matches(';').to_owned())
                        .collect();
                    if inline.iter().any(|line| line.contains('\n')) {
                        return Err(format!(
                            "{name}::{rust}: documentation on a variant's fields is not written yet"
                        ));
                    }
                    Some(format!("{{ {} }}", inline.join("; ")))
                }
            };
            let named_fields = matches!(variant.fields, Fields::Named(_));
            members.push(match (&container.tag, &container.content, container.untagged, body) {
                (_, _, true, None) => "null".to_owned(),
                (_, _, true, Some(body)) => body,
                (None, _, false, None) => format!("\"{tag}\""),
                (None, _, false, Some(body)) => format!("{{ {}: {body} }}", property(&tag)),
                (Some(key), None, false, None) => format!("{{ {}: \"{tag}\" }}", property(key)),
                (Some(key), None, false, Some(body)) if named_fields => {
                    let inner = body.trim_start_matches('{').trim_end_matches('}').trim();
                    if inner.is_empty() {
                        format!("{{ {}: \"{tag}\" }}", property(key))
                    } else {
                        format!("{{ {}: \"{tag}\"; {inner} }}", property(key))
                    }
                }
                (Some(key), None, false, Some(body)) => format!("{{ {}: \"{tag}\" }} & {body}", property(key)),
                (Some(key), Some(content), false, None) => {
                    let _ = content;
                    format!("{{ {}: \"{tag}\" }}", property(key))
                }
                (Some(key), Some(content), false, Some(body)) => {
                    format!("{{ {}: \"{tag}\"; {}: {body} }}", property(key), property(content))
                }
            });
        }
        if members.is_empty() {
            return Err(format!("{name}: an enum without variants"));
        }
        Ok(members)
    }

    fn page(&self, commands: &[CommandEntry], types: &[String]) -> String {
        let mut text = String::from(
            "// The Rust side's commands (app/src-tauri) and the shapes they take and give.\n\
             // Generated from the Rust source by `cargo run -p ipc-types`; do not edit.\n\
             // Change the Rust side and run it again (crates/ipc-types has a test that fails while this is behind).\n\n",
        );
        for (module, names) in &self.imports {
            let names: Vec<&str> = names.iter().copied().collect();
            let _ = writeln!(text, "import type {{ {} }} from \"{module}\";", names.join(", "));
        }
        if !self.imports.is_empty() {
            text.push('\n');
        }
        text.push_str(
            "/**\n * A request body of `[u32 little-endian JSON length][JSON][bytes]` (see\n * `packBody` and `projectBody`): images and the project text travel as bytes.\n */\n\
             export type RawBody = Uint8Array;\n",
        );
        for declaration in types {
            text.push('\n');
            text.push_str(declaration);
        }
        text.push_str("\n/** Each command: what it takes (`void`: nothing) and what it gives back. */\nexport interface Commands {\n");
        let mut file = "";
        for command in commands {
            if command.file != file {
                file = &command.file;
                let _ = writeln!(text, "  // {file}");
            }
            text.push_str(&comment(&command.docs, "  "));
            let _ = writeln!(text, "  {}: [{}, {}];", command.name, command.takes, command.gives);
        }
        text.push_str("}\n");
        text
    }
}

fn external(name: &str) -> Option<&'static str> {
    EXTERNAL
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, module)| *module)
}

/// An identifier without `r#`.
fn plain(ident: &syn::Ident) -> String {
    ident.to_string().trim_start_matches("r#").to_owned()
}

fn last_segment(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(path) => path.path.segments.last().map(|segment| segment.ident.to_string()),
        Type::Reference(reference) => last_segment(&reference.elem),
        _ => None,
    }
}

/// The first type between the angle brackets of `name<…>`.
fn generic_inner<'t>(ty: &'t Type, name: &str) -> Option<&'t Type> {
    let Type::Path(path) = ty else { return None };
    let segment = path.path.segments.last()?;
    if segment.ident != name {
        return None;
    }
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return None;
    };
    arguments.args.iter().find_map(|argument| match argument {
        GenericArgument::Type(ty) => Some(ty),
        _ => None,
    })
}

fn option_inner(ty: &Type) -> Option<&Type> {
    generic_inner(ty, "Option")
}

fn result_inner(ty: &Type) -> Option<&Type> {
    generic_inner(ty, "Result")
}

fn array_length(length: &Expr) -> Option<usize> {
    match length {
        Expr::Lit(literal) => match &literal.lit {
            Lit::Int(int) => int.base10_parse().ok(),
            _ => None,
        },
        _ => None,
    }
}

/// `T[]`, with brackets around a union.
fn list(element: &str) -> String {
    if alternatives(element).len() > 1 || element.contains(" & ") {
        format!("({element})[]")
    } else {
        format!("{element}[]")
    }
}

/// `A | B`, each member once and `null` last.
fn union(members: &[String]) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut null = false;
    for piece in members.iter().flat_map(|member| alternatives(member)) {
        if piece == "null" {
            null = true;
        } else if !parts.contains(&piece) {
            parts.push(piece);
        }
    }
    if null {
        parts.push("null");
    }
    parts.join(" | ")
}

/// The members of a union at its top level (not those inside brackets or quotes).
fn alternatives(ts: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0_usize;
    let mut quoted = false;
    let mut start = 0;
    for (index, character) in ts.char_indices() {
        match character {
            '"' => quoted = !quoted,
            '{' | '(' | '[' | '<' if !quoted => depth += 1,
            '}' | ')' | ']' | '>' if !quoted => depth = depth.saturating_sub(1),
            '|' if !quoted && depth == 0 => {
                parts.push(ts[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(ts[start..].trim());
    parts
}

/// A property's name, in quotes when it is not an identifier.
fn property(name: &str) -> String {
    let identifier = name
        .chars()
        .all(|character| character.is_alphanumeric() || character == '_' || character == '$')
        && !name.chars().next().is_some_and(|first| first.is_ascii_digit())
        && !name.is_empty();
    if identifier {
        name.to_owned()
    } else {
        format!("\"{name}\"")
    }
}

/// The documentation comments on an item, one string a line.
fn docs(attributes: &[Attribute]) -> Vec<String> {
    attributes
        .iter()
        .filter(|attribute| attribute.path().is_ident("doc"))
        .filter_map(|attribute| match &attribute.meta {
            syn::Meta::NameValue(pair) => match &pair.value {
                Expr::Lit(literal) => match &literal.lit {
                    Lit::Str(text) => Some(text.value()),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        })
        .flat_map(|text| {
            text.lines()
                .map(|line| line.strip_prefix(' ').unwrap_or(line).trim_end().to_owned())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Documentation as a TypeScript comment, each line after `indent`; nothing for none.
fn comment(lines: &[String], indent: &str) -> String {
    let lines: Vec<String> = lines.iter().map(|line| line.replace("*/", "*\\/")).collect();
    match lines.as_slice() {
        [] => String::new(),
        [one] => format!("{indent}/** {one} */\n"),
        many => {
            let mut text = format!("{indent}/**\n");
            for line in many {
                let _ = writeln!(text, "{indent} *{}{line}", if line.is_empty() { "" } else { " " });
            }
            let _ = writeln!(text, "{indent} */");
            text
        }
    }
}

/// A field's or a variant's name as serde's `rename_all = rule` writes it.
fn renamed(name: &str, rule: Option<&str>, variant: bool) -> Result<String, String> {
    let Some(rule) = rule else { return Ok(name.to_owned()) };
    let words: Vec<String> = if variant {
        let mut words: Vec<String> = Vec::new();
        for character in name.chars() {
            if character.is_uppercase() || words.is_empty() {
                words.push(String::new());
            }
            words.last_mut().expect("just pushed").extend(character.to_lowercase());
        }
        words
    } else {
        name.split('_')
            .filter(|word| !word.is_empty())
            .map(str::to_lowercase)
            .collect()
    };
    let capital = |word: &String| {
        let mut characters = word.chars();
        match characters.next() {
            Some(first) => first.to_uppercase().chain(characters).collect::<String>(),
            None => String::new(),
        }
    };
    Ok(match rule {
        "lowercase" if variant => name.to_lowercase(),
        "lowercase" => name.to_owned(),
        "UPPERCASE" => name.to_uppercase(),
        "PascalCase" => words.iter().map(capital).collect(),
        "camelCase" => words
            .iter()
            .enumerate()
            .map(|(index, word)| if index == 0 { word.clone() } else { capital(word) })
            .collect(),
        "snake_case" => words.join("_"),
        "SCREAMING_SNAKE_CASE" => words.join("_").to_uppercase(),
        "kebab-case" => words.join("-"),
        "SCREAMING-KEBAB-CASE" => words.join("-").to_uppercase(),
        other => return Err(format!("rename_all = \"{other}\" is not one serde has")),
    })
}

/// What `#[serde(…)]` says on a type, a field or a variant.
#[derive(Default)]
struct Serde {
    rename: Option<String>,
    rename_all: Option<String>,
    rename_all_fields: Option<String>,
    default: bool,
    flatten: bool,
    skip: bool,
    skip_serializing: bool,
    skip_deserializing: bool,
    /// `skip_serializing_if`: may be left out on the way to the front end.
    skip_if: bool,
    untagged: bool,
    tag: Option<String>,
    content: Option<String>,
    /// Written or read by a function of its own (`with`, `serialize_with`, `deserialize_with`).
    custom: bool,
}

impl Serde {
    fn of(attributes: &[Attribute], owner: &str) -> Result<Self, String> {
        let mut serde = Self::default();
        for attribute in attributes.iter().filter(|attribute| attribute.path().is_ident("serde")) {
            attribute
                .parse_nested_meta(|meta| {
                    let key = meta.path.get_ident().map(ToString::to_string).unwrap_or_default();
                    let text = |meta: &syn::meta::ParseNestedMeta| -> syn::Result<String> {
                        Ok(meta.value()?.parse::<syn::LitStr>()?.value())
                    };
                    match key.as_str() {
                        "rename" => serde.rename = Some(text(&meta)?),
                        "rename_all" => serde.rename_all = Some(text(&meta)?),
                        "rename_all_fields" => serde.rename_all_fields = Some(text(&meta)?),
                        "default" => {
                            serde.default = true;
                            if meta.input.peek(syn::Token![=]) {
                                text(&meta)?;
                            }
                        }
                        "flatten" => serde.flatten = true,
                        "skip" => serde.skip = true,
                        "skip_serializing" => serde.skip_serializing = true,
                        "skip_deserializing" => serde.skip_deserializing = true,
                        "skip_serializing_if" => {
                            serde.skip_if = true;
                            text(&meta)?;
                        }
                        "untagged" => serde.untagged = true,
                        "tag" => serde.tag = Some(text(&meta)?),
                        "content" => serde.content = Some(text(&meta)?),
                        "with" | "serialize_with" | "deserialize_with" => {
                            serde.custom = true;
                            text(&meta)?;
                        }
                        // These change what is accepted, not the shape.
                        "alias" | "bound" | "crate" => {
                            text(&meta)?;
                        }
                        "deny_unknown_fields" => {}
                        other => {
                            return Err(meta.error(format!(
                                "serde({other}) is not one crates/ipc-types knows how to write as TypeScript"
                            )));
                        }
                    }
                    Ok(())
                })
                .map_err(|error| format!("{owner}: {error}"))?;
        }
        Ok(serde)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(app: &str) -> Result<String, String> {
        render(&[SourceFile {
            source: 0,
            path: PathBuf::from("lib.rs"),
            text: app.to_owned(),
        }])
    }

    fn part<'t>(page: &'t str, from: &str) -> &'t str {
        let start = page.find(from).unwrap_or_else(|| panic!("{from} is not in:\n{page}"));
        let end = start + page[start..].find("\n}\n").map_or(page.len() - start, |end| end + 3);
        &page[start..end]
    }

    #[test]
    fn a_command_is_written_with_its_arguments_in_camel_case_and_what_it_gives() {
        let page = page(
            r#"
            /// Opens it.
            #[tauri::command]
            async fn open_it(app: tauri::AppHandle, file_path: String, max_height: Option<u32>, state: tauri::State<'_, S>) -> Result<Vec<f64>, String> { todo!() }
            #[tauri::command]
            fn quiet() {}
            #[tauri::command]
            async fn bytes(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> { todo!() }
            fn run() { tauri::generate_handler![open_it, sub::quiet, bytes]; }
            "#,
        )
        .unwrap();
        assert_eq!(
            part(&page, "export interface Commands"),
            "export interface Commands {\n  // lib.rs\n  /** Opens it. */\n  open_it: [{ filePath: string; maxHeight?: number | null }, number[]];\n  quiet: [void, void];\n  bytes: [RawBody, ArrayBuffer];\n}\n"
        );
    }

    #[test]
    fn a_struct_is_written_as_serde_sends_it() {
        let page = page(
            r#"
            /// What comes back.
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Report {
                /// Where it went.
                out_dir: PathBuf,
                size_px: [u32; 2],
                #[serde(skip_serializing_if = "Vec::is_empty")]
                problems: Vec<String>,
                backup: Option<String>,
                #[serde(skip)]
                hidden: Secret,
                #[serde(flatten)]
                more: More,
                kind: Kind,
            }
            #[derive(Serialize)]
            struct More { by_name: std::collections::BTreeMap<String, Option<i64>> }
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            enum Kind { Saved, BeforeRestore }
            #[tauri::command]
            fn report() -> Report { todo!() }
            fn run() { tauri::generate_handler![report]; }
            "#,
        )
        .unwrap();
        assert_eq!(
            part(&page, "/** What comes back. */"),
            "/** What comes back. */\nexport interface Report extends More {\n  /** Where it went. */\n  outDir: string;\n  sizePx: [number, number];\n  problems?: string[];\n  backup: string | null;\n  kind: Kind;\n}\n"
        );
        assert!(
            page.contains("export type Kind = \"saved\" | \"beforeRestore\";\n"),
            "{page}"
        );
        assert!(page.contains("  by_name: Record<string, number | null>;\n"), "{page}");
    }

    #[test]
    fn what_serde_fills_in_may_be_left_out_on_the_way_in_only() {
        let source = r#"
            #[derive(Serialize, Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Options {
                title: Option<String>,
                #[serde(default)]
                many: bool,
                name: String,
            }
            #[tauri::command]
            fn COMMAND { todo!() }
            fn run() { tauri::generate_handler![pick]; }
        "#;
        let taken = page(&source.replace("COMMAND", "pick(options: Options)")).unwrap();
        assert_eq!(
            part(&taken, "export interface Options"),
            "export interface Options {\n  title?: string | null;\n  many?: boolean;\n  name: string;\n}\n"
        );
        let given = page(&source.replace("COMMAND", "pick() -> Options")).unwrap();
        assert_eq!(
            part(&given, "export interface Options"),
            "export interface Options {\n  title: string | null;\n  many: boolean;\n  name: string;\n}\n"
        );
    }

    #[test]
    fn enums_are_written_as_unions() {
        let page = page(
            r#"
            #[derive(Serialize)]
            #[serde(untagged)]
            enum Picked { One(Option<String>), Many(Option<Vec<String>>) }
            #[derive(Serialize)]
            #[serde(tag = "kind", rename_all = "lowercase")]
            enum Edit { Check, Number { min: f64 } }
            #[derive(Serialize)]
            enum Length { Px(f64), Auto }
            #[tauri::command]
            fn all() -> (Picked, Edit, Vec<Length>) { todo!() }
            fn run() { tauri::generate_handler![all]; }
            "#,
        )
        .unwrap();
        assert!(
            page.contains("export type Picked = string | string[] | null;\n"),
            "{page}"
        );
        assert!(
            page.contains("export type Edit = { kind: \"check\" } | { kind: \"number\"; min: number };\n"),
            "{page}"
        );
        assert!(
            page.contains("export type Length = { Px: number } | \"Auto\";\n"),
            "{page}"
        );
        assert!(page.contains("  all: [void, [Picked, Edit, Length[]]];\n"), "{page}");
    }

    #[test]
    fn what_cannot_be_written_is_an_error_not_a_guess() {
        let unknown = page(
            "#[tauri::command]\nfn take(thing: other_crate::Thing) {}\nfn run() { tauri::generate_handler![take]; }",
        )
        .unwrap_err();
        assert!(unknown.contains("Thing") && unknown.contains("EXTERNAL"), "{unknown}");
        let attribute = page(
            "#[derive(Serialize)]\n#[serde(into = \"Other\")]\nstruct Odd { a: bool }\n#[tauri::command]\nfn give() -> Odd { todo!() }\nfn run() { tauri::generate_handler![give]; }",
        )
        .unwrap_err();
        assert!(attribute.contains("serde(into)"), "{attribute}");
        let unlisted = page(
            "#[tauri::command]\nfn a() {}\n#[tauri::command]\nfn b() {}\nfn run() { tauri::generate_handler![a]; }",
        )
        .unwrap_err();
        assert!(
            unlisted.contains("b is a #[tauri::command] that generate_handler! does not list"),
            "{unlisted}"
        );
        let missing =
            page("#[tauri::command]\nfn a() {}\nfn run() { tauri::generate_handler![a, gone]; }").unwrap_err();
        assert!(missing.contains("gone"), "{missing}");
    }

    #[test]
    fn a_type_of_the_same_file_wins_over_one_named_alike_elsewhere() {
        let files = [
            SourceFile {
                source: 0,
                path: PathBuf::from("lib.rs"),
                text: "#[derive(Deserialize)]\nstruct Filter { name: String }\n#[tauri::command]\nfn pick(filter: Filter) {}\nfn run() { tauri::generate_handler![pick]; }".to_owned(),
            },
            SourceFile {
                source: 1,
                path: PathBuf::from("raster.rs"),
                text: "pub enum Filter { Nearest, Linear }".to_owned(),
            },
        ];
        let page = render(&files).unwrap();
        assert!(
            page.contains("export interface Filter {\n  name: string;\n}\n"),
            "{page}"
        );
    }
}
