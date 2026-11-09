use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::paths::Chosen;

use super::cli::*;
use super::history::*;
use super::local::*;
use super::models::*;
use super::programs::*;
use super::session::*;
use super::*;

fn turn_in(dir: &Path) -> AiTurn {
    AiTurn {
        kind: AiKind::Claude,
        dir: dir.display().to_string(),
        prompt: String::new(),
        resume: None,
        model: None,
        effort: None,
        program: None,
        sandbox: None,
        images: Vec::new(),
        endpoint: None,
        messages: Vec::new(),
    }
}

#[test]
fn a_turn_runs_only_in_a_conversations_own_folder() {
    let root = tempfile::tempdir().unwrap();
    let talk = root.path().join("talk-1");
    std::fs::create_dir_all(&talk).unwrap();
    assert!(check_turn(root.path(), &turn_in(&talk)).is_ok());
    // Not the folder of all conversations, not one deeper, not one elsewhere, not one that is not there.
    assert!(check_turn(root.path(), &turn_in(root.path())).is_err());
    std::fs::create_dir_all(talk.join("deeper")).unwrap();
    assert!(check_turn(root.path(), &turn_in(&talk.join("deeper"))).is_err());
    let elsewhere = tempfile::tempdir().unwrap();
    assert!(check_turn(root.path(), &turn_in(elsewhere.path())).is_err());
    assert!(check_turn(root.path(), &turn_in(&root.path().join("missing"))).is_err());
    // Its pictures are files of that folder.
    let mut turn = turn_in(&talk);
    turn.images = vec!["page-1.png".to_owned()];
    assert!(check_turn(root.path(), &turn).is_ok());
    turn.images = vec!["../other/page-1.png".to_owned()];
    assert!(check_turn(root.path(), &turn).is_err());
}

#[test]
fn a_named_program_runs_only_when_it_was_picked() {
    let dir = tempfile::tempdir().unwrap();
    let named = dir.path().join(if cfg!(windows) { "tool.exe" } else { "tool" });
    std::fs::write(&named, b"").unwrap();
    let text = named.display().to_string();
    let chosen = Chosen::default();
    let refused = program("claude", Some(&text), &chosen).unwrap_err();
    assert!(refused.contains("参照"), "{refused}");
    chosen.file(&named);
    assert_eq!(program("claude", Some(&text), &chosen).unwrap(), named);
    // One that is not there is said to be missing, picked or not.
    let missing = dir.path().join("gone").display().to_string();
    assert!(
        program("claude", Some(&missing), &chosen)
            .unwrap_err()
            .contains("ファイルがありません")
    );
}

fn turn(kind: AiKind) -> AiTurn {
    AiTurn {
        kind,
        dir: "/tmp/session-1".to_owned(),
        prompt: "こんにちは".to_owned(),
        resume: None,
        model: None,
        effort: None,
        program: None,
        sandbox: None,
        images: vec!["pages/p001.png".to_owned()],
        endpoint: None,
        messages: Vec::new(),
    }
}

#[test]
fn an_effort_goes_to_either_tool_and_only_as_one_word() {
    let mut claude = turn(AiKind::Claude);
    claude.effort = Some("high".to_owned());
    let args = claude_args(&claude);
    assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
    let mut codex = turn(AiKind::Codex);
    codex.effort = Some("xhigh".to_owned());
    let args = codex_args(&codex);
    assert!(
        args.windows(2)
            .any(|pair| pair == ["-c", "model_reasoning_effort=\"xhigh\""])
    );
    codex.resume = Some("019c".to_owned());
    assert!(
        codex_args(&codex)
            .iter()
            .any(|arg| arg == "model_reasoning_effort=\"xhigh\"")
    );
    codex.effort = Some("high\" sandbox_mode=\"danger".to_owned());
    assert!(!codex_args(&codex).iter().any(|arg| arg.contains("danger")));
    codex.effort = Some(String::new());
    assert!(!codex_args(&codex).iter().any(|arg| arg.contains("effort")));
}

#[test]
fn models_as_each_tool_lists_them() {
    let claude: Value = serde_json::from_str(
        r#"{"models":[
            {"value":"default","displayName":"Default (recommended)","description":"Sonnet","supportsEffort":true,"supportedEffortLevels":["low","high"]},
            {"value":"opus","displayName":"Opus","description":"Opus 5.5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"old","displayName":"Old","supportsEffort":false}
        ]}"#,
    )
    .unwrap();
    let models = claude_models(&claude);
    assert_eq!(models.len(), 3);
    assert_eq!((models[0].value.as_str(), models[0].is_default), ("", true));
    assert_eq!(models[1].value, "opus");
    assert_eq!(models[1].efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert!(models[2].efforts.is_empty());
    let codex: Value = serde_json::from_str(
        r#"{"data":[
            {"id":"a","model":"gpt-a","displayName":"GPT-A","description":"d","hidden":false,"isDefault":true,"defaultReasoningEffort":"low",
             "supportedReasoningEfforts":[{"reasoningEffort":"low","description":""},{"reasoningEffort":"high","description":""}]},
            {"id":"h","model":"gpt-hidden","hidden":true,"supportedReasoningEfforts":[]}
        ],"nextCursor":null}"#,
    )
    .unwrap();
    let models = codex_models(&codex);
    assert_eq!(models.len(), 1);
    assert_eq!(
        models[0],
        AiModel {
            value: "gpt-a".to_owned(),
            label: "GPT-A".to_owned(),
            description: "d".to_owned(),
            efforts: vec!["low".to_owned(), "high".to_owned()],
            default_effort: Some("low".to_owned()),
            is_default: true,
        }
    );
}

#[test]
fn claude_reads_but_does_not_write() {
    let mut first = turn(AiKind::Claude);
    let args = claude_args(&first);
    assert_eq!(&args[..3], ["-p", "--output-format", "stream-json"]);
    let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1];
    assert_eq!(
        allowed,
        "Read,Glob,Grep,Bash(node .claude/skills/name-studio/scripts/namestudio.mjs:*)"
    );
    assert!(
        args.iter()
            .any(|arg| arg == "Write,Edit,NotebookEdit,WebFetch,WebSearch")
    );
    assert!(!args.contains(&"--resume".to_owned()));
    first.resume = Some("abc".to_owned());
    first.model = Some("sonnet".to_owned());
    let args = claude_args(&first);
    assert!(args.windows(2).any(|pair| pair == ["--resume", "abc"]));
    assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
}

#[test]
fn past_conversations_are_kept_listed_newest_first_and_only_by_their_id() {
    let root = std::env::temp_dir().join(format!("ns-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let talk = |id: &str, updated: f64| serde_json::json!({"id": id, "kind": "codex", "name": "C:\\a.namestudio", "title": "詰まった", "created": 1.0, "updated": updated, "session": "019c", "entries": [{"role": "user", "text": "詰まった"}, {"role": "assistant", "text": "**案**"}, {"role": "user", "text": "次"}]});
    save_talk(&root, &talk("t-1", 10.0)).unwrap();
    save_talk(&root, &talk("t-2", 20.0)).unwrap();
    let listed = list_talks(&root);
    assert_eq!(
        listed
            .iter()
            .map(|talk| talk["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["t-2", "t-1"]
    );
    assert_eq!(listed[0]["count"], 2);
    assert!(listed[0].get("entries").is_none());
    assert_eq!(load_talk(&root, "t-1").unwrap()["entries"][1]["text"], "**案**");
    // Saved again: replaced, not added.
    save_talk(&root, &talk("t-1", 30.0)).unwrap();
    assert_eq!(list_talks(&root)[0]["id"], "t-1");
    assert_eq!(list_talks(&root).len(), 2);
    assert!(save_talk(&root, &talk("../x", 1.0)).is_err());
    assert!(load_talk(&root, "..\\x").is_err());
    assert!(load_talk(&root, "nope").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn codex_on_windows_runs_in_the_mxc_sandbox_unless_told_otherwise() {
    let mut codex = turn(AiKind::Codex);
    let on = |codex: &AiTurn| codex_args_on(codex, true);
    assert!(
        on(&codex)
            .windows(2)
            .any(|pair| pair == ["-c", "windows.sandbox=\"mxc\""])
    );
    assert!(
        !codex_args_on(&codex, false)
            .iter()
            .any(|arg| arg.contains("windows.sandbox"))
    );
    codex.resume = Some("019c".to_owned());
    assert!(on(&codex).iter().any(|arg| arg == "windows.sandbox=\"mxc\""));
    codex.sandbox = Some("config".to_owned());
    assert!(!on(&codex).iter().any(|arg| arg.contains("windows.sandbox")));
    codex.sandbox = Some("elevated".to_owned());
    assert!(on(&codex).iter().any(|arg| arg == "windows.sandbox=\"elevated\""));
    codex.sandbox = Some("x\" sandbox_mode=\"danger".to_owned());
    assert!(!on(&codex).iter().any(|arg| arg.contains("danger")));
    // A command the sandbox turned away says what to do.
    let line = r#"{"type":"item.completed","item":{"type":"command_execution","command":"pwsh","aggregated_output":"exec_command failed: CreateProcess { message: \"Rejected(\\\"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\\\")\" }","status":"failed"}}"#;
    let events = codex_events(1, line);
    assert_eq!(events.len(), 1);
    assert!(events[0].text.contains("「詳しく」でサンドボックス"));
    let fine = r#"{"type":"item.completed","item":{"type":"command_execution","command":"pwsh","aggregated_output":"ok","status":"completed"}}"#;
    assert!(codex_events(1, fine).is_empty());
}

#[test]
fn codex_runs_read_only_and_goes_on_with_its_thread() {
    let mut first = turn(AiKind::Codex);
    let args = codex_args(&first);
    assert_eq!(args[0], "exec");
    assert!(args.windows(2).any(|pair| pair == ["--sandbox", "read-only"]));
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--image" && pair[1].ends_with("p001.png"))
    );
    assert_eq!(&args[args.len() - 2..], ["--", "-"]);
    first.resume = Some("019c".to_owned());
    let args = codex_args(&first);
    assert_eq!(&args[..5], ["exec", "resume", "019c", "-c", "sandbox_mode=read-only"]);
    assert!(!args.contains(&"--cd".to_owned()));
}

#[test]
fn claude_stream_becomes_events() {
    let mut streamed = false;
    let lines = [
        r#"{"type":"system","subtype":"init","session_id":"s-1"}"#,
        r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"こん"}}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:\\x\\ネーム.md"}}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"全部"}]}}"#,
        r#"{"type":"result","is_error":false,"result":"全部"}"#,
    ];
    let events: Vec<(String, String)> = lines
        .iter()
        .flat_map(|line| claude_events(7, line, &mut streamed))
        .map(|event| (event.kind, event.text))
        .collect();
    let pairs: Vec<(&str, &str)> = events.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    assert_eq!(
        pairs,
        [
            ("session", "s-1"),
            ("delta", "こん"),
            ("tool", "Read: ネーム.md"),
            ("text", "全部"),
            ("done", "")
        ]
    );
    let failed = claude_events(
        7,
        r#"{"type":"result","is_error":true,"result":"Not logged in"}"#,
        &mut streamed,
    );
    assert_eq!(
        (failed[0].kind.as_str(), failed[0].text.as_str()),
        ("error", "Not logged in")
    );
    assert!(with_hint(AiKind::Claude, "Failed to authenticate: OAuth session expired").contains("/login"));
    assert!(with_hint(AiKind::Codex, "401 Unauthorized").contains("codex login"));
    assert_eq!(with_hint(AiKind::Claude, "quota"), "quota");
}

#[test]
fn codex_stream_becomes_events() {
    let kinds: Vec<(String, String)> = [
        r#"{"type":"thread.started","thread_id":"019c"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"案です"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_2","type":"error","message":"ignoring unknown config key"}}"#,
        r#"{"type":"turn.completed","usage":{}}"#,
        r#"{"type":"turn.failed","error":{"message":"quota"}}"#,
    ]
    .iter()
    .flat_map(|line| codex_events(1, line))
    .map(|event| (event.kind, event.text))
    .collect();
    let pairs: Vec<(&str, &str)> = kinds.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    assert_eq!(
        pairs,
        [
            ("session", "019c"),
            ("tool", "command: bash -lc ls"),
            ("text", "案です"),
            ("done", ""),
            ("error", "quota")
        ]
    );
}

#[test]
fn local_llm_body_and_stream() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("pages")).unwrap();
    std::fs::write(dir.path().join("pages").join("p001.png"), [1, 2, 3]).unwrap();
    let messages = vec![
        ChatMessage {
            role: "system".to_owned(),
            content: "相談相手".to_owned(),
            images: Vec::new(),
        },
        ChatMessage {
            role: "user".to_owned(),
            content: "見て".to_owned(),
            images: vec!["pages/p001.png".to_owned(), "../secret.png".to_owned()],
        },
    ];
    let body = chat_body("llama3", &messages, dir.path());
    assert_eq!(body["model"], "llama3");
    assert_eq!(body["messages"][0]["content"], "相談相手");
    let parts = body["messages"][1]["content"].as_array().unwrap();
    assert_eq!(parts.len(), 2, "the picture inside the folder only");
    assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AQID");
    assert_eq!(
        chat_delta(r#"data: {"choices":[{"delta":{"content":"や"}}]}"#),
        Some(Some("や".to_owned()))
    );
    assert_eq!(chat_delta("data: [DONE]"), Some(None));
    assert_eq!(chat_delta(": keep-alive"), None);
    assert_eq!(
        api_url("http://localhost:11434/v1/", "models"),
        "http://localhost:11434/v1/models"
    );
}

#[test]
fn a_session_folder_holds_its_files_and_the_skill_and_nothing_outside() {
    let root = tempfile::tempdir().unwrap();
    let now = SystemTime::now();
    let files = vec![
        SessionFile {
            path: "ネーム.md".to_owned(),
            text: Some("# ネーム".to_owned()),
            base64: None,
        },
        SessionFile {
            path: "pages/p001.png".to_owned(),
            text: None,
            base64: Some("AQID".to_owned()),
        },
    ];
    let dir = prepare_session(root.path(), None, &files, now).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("ネーム.md")).unwrap(), "# ネーム");
    assert_eq!(std::fs::read(dir.join("pages").join("p001.png")).unwrap(), [1, 2, 3]);
    assert!(dir.join(SKILL_COMMAND).is_file());
    assert!(dir.join(".agents/skills/name-studio/SKILL.md").is_file());
    // Brought up to date in the same folder.
    let again = prepare_session(root.path(), Some(&dir.display().to_string()), &files[..1], now).unwrap();
    assert_eq!(again, dir);
    for bad in ["../x.md", "a/../../x", "C:/x", "/x", "a\\b"] {
        let file = SessionFile {
            path: bad.to_owned(),
            text: Some(String::new()),
            base64: None,
        };
        assert!(
            prepare_session(root.path(), Some(&dir.display().to_string()), &[file], now).is_err(),
            "{bad}"
        );
    }
    assert!(prepare_session(root.path(), Some("/tmp"), &[], now).is_err());
    // Old ones go when a new one is made.
    let later = now + KEEP_SESSIONS + Duration::from_secs(60);
    let newer = prepare_session(root.path(), None, &[], later).unwrap();
    assert!(!dir.exists());
    assert!(newer.exists());
}

/// One real turn and its follow-up with the AI named by `NAME_STUDIO_AI_LIVE`
/// ("claude" or "codex", installed and signed in), through the same
/// folder, arguments and reading of its output as the app. Not run by
/// default: `NAME_STUDIO_AI_LIVE=codex cargo test -p name-studio-app --lib ai::tests::live -- --ignored --nocapture`
#[test]
#[ignore = "talks to a real Claude Code / Codex"]
fn live() {
    let kind = match std::env::var("NAME_STUDIO_AI_LIVE").as_deref() {
        Ok("claude") => AiKind::Claude,
        Ok("codex") => AiKind::Codex,
        _ => panic!("NAME_STUDIO_AI_LIVE=claude か codex"),
    };
    let root = tempfile::tempdir().unwrap();
    let brief = "# ネーム「屋上」\n\n## ページ\n### p1\n- コマ1\n  - [line9] ミカ「星、見えないね」\n";
    let files = vec![SessionFile {
        path: "ネーム.md".to_owned(),
        text: Some(brief.to_owned()),
        base64: None,
    }];
    // The same instructions under the names each reads, as the app writes them.
    let rule = "あなたは漫画のネームの相談相手です。変更の案は ```namestudio-ops のブロックに JSON 配列で書きます。";
    let files: Vec<SessionFile> = files
        .into_iter()
        .chain(["SYSTEM.md", "CLAUDE.md", "AGENTS.md"].map(|path| SessionFile {
            path: path.to_owned(),
            text: Some(rule.to_owned()),
            base64: None,
        }))
        .collect();
    let dir = prepare_session(root.path(), None, &files, SystemTime::now()).unwrap();
    // The models as the tool lists them; the one named in NAME_STUDIO_AI_MODEL must be among them.
    let path = program(
        if kind == AiKind::Claude { "claude" } else { "codex" },
        None,
        &Chosen::default(),
    )
    .unwrap();
    let models = if kind == AiKind::Claude {
        list_claude_models(&path)
    } else {
        list_codex_models(&path)
    }
    .unwrap();
    for model in &models {
        println!(
            "model: {:?} {} {:?} {:?}",
            model.value, model.label, model.efforts, model.default_effort
        );
    }
    assert!(models.iter().any(|model| model.is_default), "no default model");
    let model = std::env::var("NAME_STUDIO_AI_MODEL").ok();
    let chosen = models
        .iter()
        .find(|found| Some(&found.value) == model.as_ref() || (model.is_none() && found.is_default))
        .expect("NAME_STUDIO_AI_MODEL is not in the list");
    // The lightest effort it takes, to show an effort goes through.
    let effort = chosen.efforts.first().cloned();
    let mut session = None;
    for (number, prompt) in [
        "ネーム.md を読んで、line9 のセリフを少し寂しげにする変更の案を 1 つだけ出してください。",
        "いまの案の文だけを、もう一度ひとことで。",
    ]
    .into_iter()
    .enumerate()
    {
        let turn = AiTurn {
            kind,
            dir: dir.display().to_string(),
            prompt: prompt.to_owned(),
            resume: session.clone(),
            model: model.clone(),
            effort: effort.clone(),
            program: None,
            sandbox: None,
            images: Vec::new(),
            endpoint: None,
            messages: Vec::new(),
        };
        let mut child = start_process(&turn, &Chosen::default()).unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let events = Mutex::new(Vec::new());
        run_process(1, &turn, Arc::new(Mutex::new(child)), stdout, stderr, &|event| {
            println!("{}: {}", event.kind, event.text);
            events.lock().unwrap().push(event);
        });
        let events = events.into_inner().unwrap();
        let said: String = events
            .iter()
            .filter(|event| event.kind == "delta" || event.kind == "text")
            .map(|event| event.text.as_str())
            .collect();
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("done"),
            "turn {number}"
        );
        assert!(!said.trim().is_empty(), "turn {number} said nothing");
        if number == 0 {
            assert!(said.contains("namestudio-ops"), "no 変更の案: {said}");
            session = events
                .iter()
                .find(|event| event.kind == "session")
                .map(|event| event.text.clone());
            assert!(session.is_some(), "no session id");
        }
    }
    assert!(!dir.join("ネーム.md").metadata().unwrap().permissions().readonly());
    assert_eq!(
        std::fs::read_to_string(dir.join("ネーム.md")).unwrap(),
        brief,
        "the AI wrote a file"
    );
}
