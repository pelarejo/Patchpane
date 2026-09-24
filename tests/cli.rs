use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "patchpane-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        let r = Self(path);
        r.git(&["init", "-q"]);
        r.git(&["config", "user.name", "Patchpane tests"]);
        r.git(&["config", "user.email", "test@example.invalid"]);
        r.git(&["config", "commit.gpgsign", "false"]);
        r.git(&["config", "core.autocrlf", "false"]);
        r
    }
    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn write(&self, name: &str, content: &[u8]) {
        fs::write(self.0.join(name), content).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_patchpane"))
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .unwrap()
    }
    fn html(&self, args: &[&str]) -> String {
        let mut command_args = vec!["--no-open", "-o", "-"];
        command_args.extend_from_slice(args);
        let args = command_args;
        let output = self.run(&args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "fixture"]);
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn working_staged_revisions_and_path_filters() {
    let r = Repo::new();
    r.write("one.rs", b"old\n");
    r.write("two.rs", b"before\n");
    r.commit();
    r.write("one.rs", b"staged\n");
    r.git(&["add", "one.rs"]);
    r.write("one.rs", b"working\n");
    r.write("two.rs", b"after\n");
    r.write("untracked", b"hidden\n");
    let h = r.html(&[]);
    assert!(h.contains("+working"));
    assert!(!h.contains("\"path\":\"untracked\""));
    let h = r.html(&["."]);
    assert!(h.contains("+working"));
    assert!(h.contains("+after"));
    let h = r.html(&["two.rs"]);
    assert!(h.contains("\"path\":\"two.rs\""));
    assert!(!h.contains("\"path\":\"one.rs\""));
    let h = r.html(&["--staged"]);
    assert!(h.contains("+staged"));
    assert!(!h.contains("+working"));
    let h = r.html(&["--", "two.rs"]);
    assert!(h.contains("\"path\":\"two.rs\""));
    assert!(!h.contains("\"path\":\"one.rs\""));
    r.commit();
    let h = r.html(&["HEAD~1...HEAD"]);
    assert!(h.contains("+working"));
    let h = r.html(&["HEAD~1", "HEAD"]);
    assert!(h.contains("+after"));
    assert!(r.html(&[]).contains("\"files\":[]"));
    assert!(
        !r.run(&["nonexistent-revision", "--no-open"])
            .status
            .success()
    );
}

#[test]
fn renames_binary_empty_mode_and_unusual_names() {
    let r = Repo::new();
    r.write("original", b"same\n");
    r.write("binary", b"a\0b");
    r.write("deleted", b"gone\n");
    r.write("script", b"echo test\n");
    r.commit();
    let renamed = if cfg!(unix) {
        "renamed\tfile\n.txt"
    } else {
        "renamed file.txt"
    };
    r.git(&["mv", "original", renamed]);
    r.write("binary", b"a\0c");
    r.git(&["rm", "deleted"]);
    r.write("empty", b"");
    r.write(
        if cfg!(unix) {
            "evil <tag>.txt"
        } else {
            "evil.txt"
        },
        b"</script><script>alert(1)</script>\n",
    );
    r.git(&["add", "."]);
    r.git(&["update-index", "--chmod=+x", "script"]);
    let h = r.html(&["--staged"]);
    assert!(h.contains("new mode 100755"));
    assert!(h.contains("\"oldPath\":\"original\""));
    if cfg!(unix) {
        assert!(h.contains("renamed\\u0009file\\u000a.txt"));
    } else {
        assert!(h.contains("renamed file.txt"));
    }
    assert!(h.contains("\"binary\":true"));
    assert!(h.contains("\"path\":\"empty\""));
    assert!(h.contains("deleted file mode"));
    assert!(!h.contains("</script><script>alert"));
    assert!(h.contains("\\u003c/script>"));
}

#[test]
fn default_output_uses_calling_directory_even_with_repo_option() {
    let r = Repo::new();
    let caller = r.0.join("caller");
    fs::create_dir(&caller).unwrap();
    for _ in 0..2 {
        let output = Command::new(env!("CARGO_BIN_EXE_patchpane"))
            .current_dir(&caller)
            .arg("-C")
            .arg(&r.0)
            .arg("--no-open")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let files: Vec<_> = fs::read_dir(caller.join("patchpane")).unwrap().collect();
    assert_eq!(files.len(), 2);
    for file in files {
        let path = file.unwrap().path();
        assert_eq!(path.extension().unwrap(), "html");
        assert!(
            fs::read_to_string(path)
                .unwrap()
                .starts_with("<!doctype html>")
        );
    }
    assert!(!r.0.join("patchpane").exists());
}

#[test]
fn unborn_index_and_output_protection() {
    let r = Repo::new();
    r.write("new", b"first\n");
    r.git(&["add", "."]);
    assert!(r.html(&["--cached"]).contains("+first"));
    let path = r.0.join("review.html");
    let path = path.to_str().unwrap();
    assert!(
        r.run(&["--cached", "--no-open", "-o", path])
            .status
            .success()
    );
    let original = fs::read(path).unwrap();
    assert!(
        !r.run(&["--cached", "--no-open", "-o", path])
            .status
            .success()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn user_presentation_config_and_external_helpers_do_not_break_diff() {
    let r = Repo::new();
    r.write("a", b"old\n\nline\n");
    r.commit();
    r.write("a", b"new\n\nline\n");
    for (key, value) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.suppressBlankEmpty", "true"),
        ("color.ui", "always"),
        ("diff.external", "/does/not/exist"),
    ] {
        r.git(&["config", key, value]);
    }
    assert!(r.html(&[]).contains("+new"));
}

#[test]
fn large_diff_keeps_every_line_in_one_self_contained_document() {
    let r = Repo::new();
    r.write("large", b"old\n");
    r.commit();
    let content = (0..25_000)
        .map(|n| format!("line {n}\n"))
        .collect::<String>();
    r.write("large", content.as_bytes());
    let h = r.html(&[]);
    assert!(h.contains("+line 24999"));
    assert!(h.contains("\"added\":25000"));
    assert!(!h.contains("<script src="));
    assert!(!h.contains("<link "));
}

#[test]
fn includes_untracked_without_changing_index_and_respects_ignores() {
    let r = Repo::new();
    r.write(".gitignore", b"ignored\n");
    r.commit();
    let before = fs::read(r.0.join(".git/index")).unwrap();
    r.write("new file.txt", b"first\nlast");
    r.write("empty", b"");
    r.write("binary", b"a\0b");
    r.write("ignored", b"should not appear\n");
    let h = r.html(&["--include-untracked"]);
    assert!(h.contains("\"path\":\"new file.txt\",\"oldPath\":null,\"added\":2"));
    assert!(h.contains("+first\\u000a+last"));
    assert!(h.contains("No newline at end of file"));
    assert!(h.contains("\"path\":\"empty\""));
    assert!(h.contains("\"binary\":true"));
    assert!(!h.contains("\"path\":\"ignored\""));
    assert_eq!(fs::read(r.0.join(".git/index")).unwrap(), before);
    assert!(r.html(&[]).contains("\"files\":[]"));
}

#[test]
fn untracked_path_filters_work_with_dot_revisions_and_staged() {
    let r = Repo::new();
    r.write("tracked", b"old\n");
    r.commit();
    fs::create_dir(r.0.join("src")).unwrap();
    r.write("src/new.rs", b"new\n");
    r.write("outside", b"excluded\n");
    for args in [
        vec!["--include-untracked", "src/"],
        vec!["--include-untracked", "--", "src/"],
        vec!["--include-untracked", "HEAD", "--", "src/"],
        vec!["--include-untracked", "--staged", "--", "src/"],
    ] {
        let h = r.html(&args);
        assert!(h.contains("new.rs"));
        assert!(!h.contains("\"path\":\"outside\""));
    }
    for args in [
        vec!["--include-untracked", "."],
        vec!["--include-untracked", "HEAD...HEAD"],
    ] {
        let h = r.html(&args);
        assert!(h.contains("new.rs"));
        assert!(h.contains("\"path\":\"outside\""));
    }
}

#[cfg(unix)]
#[test]
fn untracked_symlink_is_shown_without_reading_its_target() {
    let r = Repo::new();
    std::os::unix::fs::symlink("missing-target", r.0.join("link")).unwrap();
    r.write("odd\tname\n.txt", b"</script>\n");
    let h = r.html(&["--include-untracked"]);
    assert!(h.contains("new file mode 120000"));
    assert!(h.contains("+missing-target"));
    assert!(h.contains("odd\\u0009name\\u000a.txt"));
    assert!(h.contains("+\\u003c/script>"));
}
