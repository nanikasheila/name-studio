//! Starting a program so that it can be stopped with everything it started.
//!
//! Claude Code and Codex are often a small launcher that starts the real
//! program (a `.cmd` that runs Node, Node that runs a binary). Stopping only
//! what this app started would leave the rest running: still thinking, still
//! using up the plan, and holding the pipe this app reads. So a program is
//! started in a group of its own ([`own_group`]) and the whole group is
//! stopped ([`kill_tree`]).

use std::process::{Child, Command};

/// Have `command` start its program as the head of a group of its own.
pub fn own_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// Stop `child` (started with [`own_group`]) and all it started.
pub fn kill_tree(child: &mut Child) {
    // Already ended: its number may be another program's by now.
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    {
        if let Ok(group) = i32::try_from(child.id()) {
            // The group's number is its head's: a minus sign means the whole group.
            // SAFETY: `kill` only sends a signal; it takes no pointers.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // /T: with what it started; /F: without asking it.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// A launcher that starts a long-running program, says its number and waits for it.
    fn launcher() -> Command {
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 60 & echo $!; wait"]);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("powershell");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$p = Start-Process -FilePath ping -ArgumentList '-n','60','127.0.0.1' -PassThru -NoNewWindow -RedirectStandardOutput NUL; $p.Id; Wait-Process -Id $p.Id",
            ]);
            command
        }
    }

    fn alive(id: u32) -> bool {
        #[cfg(unix)]
        {
            // A program that ended but was not waited for is still listed: read its state.
            match std::fs::read_to_string(format!("/proc/{id}/stat")) {
                Ok(stat) => !stat
                    .rsplit(')')
                    .next()
                    .is_some_and(|rest| rest.trim_start().starts_with('Z')),
                // No /proc (macOS): signal 0 asks only whether it is there.
                Err(_) if !std::path::Path::new("/proc/self").exists() => unsafe { libc::kill(id as i32, 0) == 0 },
                Err(_) => false,
            }
        }
        #[cfg(windows)]
        {
            let listed = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {id}"), "/NH", "/FO", "CSV"])
                .output()
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default();
            listed.contains(&format!("\"{id}\""))
        }
    }

    #[test]
    fn stopping_a_launcher_stops_what_it_started() {
        let mut command = launcher();
        let mut child = own_group(&mut command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let started: u32 = line
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("the launcher said {line:?}"));
        assert!(alive(started), "what the launcher started runs");

        kill_tree(&mut child);
        let _ = child.wait();
        let until = Instant::now() + Duration::from_secs(10);
        while alive(started) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(started), "what the launcher started is stopped with it");
    }

    #[test]
    fn a_program_that_ended_is_left_alone() {
        #[cfg(unix)]
        let mut command = Command::new("true");
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 0"]);
            command
        };
        let mut child = own_group(&mut command).spawn().unwrap();
        let _ = child.wait();
        kill_tree(&mut child);
    }
}
