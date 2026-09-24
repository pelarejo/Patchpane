use std::{
    env,
    ffi::OsString,
    fs::OpenOptions,
    io::{self, Write},
    path::PathBuf,
    process::{Command, ExitCode},
    time::{SystemTime, UNIX_EPOCH},
};

const HELP: &str = "Patchpane — local Git diffs in a single HTML file

Usage: patchpane [OPTIONS] [REVISION [REVISION]] [-- PATH...]

  --staged, --cached     Compare the index with HEAD
  --include-untracked   Append non-ignored untracked files as additions
  -C, --repo DIR         Run Git in DIR
  -o, --output FILE      Write FILE (use - for stdout); default: $PWD/patchpane/
  --no-open, --open     Disable/enable browser opening
  --unstaged            Override a configured staged comparison
  --no-include-untracked  Override configured untracked file inclusion
  --output-dir DIR      Report directory (default filename: report.html)
  --new-report          Create a uniquely named report on each run
  --overwrite           Replace the report (default; overrides config)
  --no-config           Ignore the project .patchpane configuration
  --context N           Context lines per hunk (default: 3)
  -h, --help            Show help
  -V, --version         Show version

Examples:
  patchpane main...HEAD
  patchpane HEAD~3 HEAD -- src/
  patchpane --staged --no-open -o review.html

With no revision, shows unstaged tracked changes, like git diff.
Untracked files are excluded unless --include-untracked is set.
Reports are replaced by default; use --new-report to retain each run.
Paths such as '.' are accepted directly; use '-- PATH...' to disambiguate.
Defaults are read from .patchpane at the Git root; CLI options take priority.
";

#[derive(Default)]
struct Options {
    repo: Option<OsString>,
    output: Option<OsString>,
    output_dir: Option<PathBuf>,
    no_config: bool,
    new_report: bool,
    revisions: Vec<OsString>,
    paths: Vec<OsString>,
    path_separator: bool,
    staged: bool,
    include_untracked: bool,
    no_open: bool,
    context: u32,
}

fn options(args: impl Iterator<Item = OsString>) -> Result<Option<Options>, String> {
    options_with_defaults(
        args,
        Options {
            context: 3,
            ..Options::default()
        },
    )
}

fn options_with_defaults(
    args: impl Iterator<Item = OsString>,
    mut opt: Options,
) -> Result<Option<Options>, String> {
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("-h" | "--help") => {
                print!("{HELP}");
                return Ok(None);
            }
            Some("-V" | "--version") => {
                println!("patchpane {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--") => {
                opt.path_separator = true;
                opt.paths.extend(args);
                break;
            }
            Some("--staged" | "--cached") => opt.staged = true,
            Some("--no-open") => opt.no_open = true,
            Some("--open") => opt.no_open = false,
            Some("--unstaged") => opt.staged = false,
            Some("--no-include-untracked") => opt.include_untracked = false,
            Some("--no-config") => opt.no_config = true,
            Some("--new-report") => opt.new_report = true,
            Some("--overwrite") => opt.new_report = false,
            Some("--include-untracked") => opt.include_untracked = true,
            Some("-C" | "--repo" | "-o" | "--output" | "--output-dir" | "--context") => {
                let value = args
                    .next()
                    .ok_or_else(|| format!("{} requires a value", arg.to_string_lossy()))?;
                match arg.to_str().unwrap() {
                    "-C" | "--repo" => opt.repo = Some(value),
                    "-o" | "--output" => {
                        opt.output = Some(value);
                        opt.output_dir = None;
                    }
                    "--output-dir" => {
                        opt.output_dir = Some(PathBuf::from(value));
                        opt.output = None;
                    }
                    _ => {
                        opt.context = value
                            .to_str()
                            .and_then(|v| v.parse().ok())
                            .filter(|v| *v <= 100_000)
                            .ok_or("context must be between 0 and 100000")?
                    }
                }
            }
            _ if arg.to_string_lossy().starts_with('-') => {
                return Err(format!("unknown option: {}", arg.to_string_lossy()));
            }
            _ => opt.revisions.push(arg),
        }
    }
    if opt.revisions.len() > if opt.staged { 1 } else { 2 } {
        return Err("expected at most two revisions (one with --staged)".into());
    }
    Ok(Some(opt))
}

#[derive(Debug)]
struct FileDiff {
    path: String,
    old_path: Option<String>,
    added: usize,
    removed: usize,
    binary: bool,
    patch: String,
}

fn nul_field<'a>(data: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let end = data[*pos..]
        .iter()
        .position(|b| *b == 0)
        .ok_or("invalid Git diff: missing NUL separator")?
        + *pos;
    let field = &data[*pos..end];
    *pos = end + 1;
    Ok(field)
}

// Git's NUL-delimited numstat provides exact paths, including tabs, newlines and renames.
// It and the patch come from one invocation, so their order and snapshot agree.
fn parse_diff(data: &[u8]) -> Result<Vec<FileDiff>, String> {
    if data.is_empty() {
        return Ok(vec![]);
    }
    let mut pos = 0;
    let mut files = Vec::new();
    loop {
        let record = nul_field(data, &mut pos)?;
        if record.is_empty() {
            break;
        }
        let fields: Vec<_> = record.splitn(3, |b| *b == b'\t').collect();
        if fields.len() != 3 {
            return Err("invalid Git numstat record".into());
        }
        let binary = fields[0] == b"-";
        let count = |b: &[u8]| -> Result<usize, String> {
            if b == b"-" {
                Ok(0)
            } else {
                String::from_utf8_lossy(b)
                    .parse()
                    .map_err(|_| "invalid Git line count".into())
            }
        };
        let (old_path, path) = if fields[2].is_empty() {
            let old = nul_field(data, &mut pos)?;
            let new = nul_field(data, &mut pos)?;
            (
                Some(String::from_utf8_lossy(old).into_owned()),
                String::from_utf8_lossy(new).into_owned(),
            )
        } else {
            (None, String::from_utf8_lossy(fields[2]).into_owned())
        };
        files.push(FileDiff {
            path,
            old_path,
            added: count(fields[0])?,
            removed: count(fields[1])?,
            binary,
            patch: String::new(),
        });
    }
    let patch = String::from_utf8_lossy(&data[pos..]);
    let mut index: usize = 0;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            index += 1;
        }
        let file = index
            .checked_sub(1)
            .and_then(|i| files.get_mut(i))
            .ok_or("invalid Git patch structure")?;
        file.patch.push_str(line);
    }
    if index != files.len() {
        return Err("Git patch and file list disagree".into());
    }
    Ok(files)
}

// Also escape '<' so repository contents cannot terminate the JSON script element.
fn json(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '<' => out.push_str("\\u003c"),
            '&' => out.push_str("\\u0026"),
            c if c <= '\u{1f}' || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn render(title: &str, files: &[FileDiff]) -> String {
    let data = files.iter().map(|f| format!("{{\"path\":{},\"oldPath\":{},\"added\":{},\"removed\":{},\"binary\":{},\"patch\":{}}}", json(&f.path), f.old_path.as_deref().map(json).unwrap_or("null".into()), f.added, f.removed, f.binary, json(&f.patch))).collect::<Vec<_>>().join(",");
    include_str!("page.html")
        .replace("/* PATCHPANE_CSS */", include_str!("style.css"))
        .replace("/* PATCHPANE_JS */", include_str!("viewer.js"))
        .replace(
            "<!-- PATCHPANE_DATA -->",
            &format!("{{\"title\":{},\"files\":[{}]}}", json(title), data),
        )
}

fn git_command(opt: &Options) -> Command {
    let mut command = Command::new("git");
    if let Some(repo) = &opt.repo {
        command.arg("-C").arg(repo);
    }
    command
}

fn git_output(command: &mut Command) -> Result<Vec<u8>, String> {
    let output = command.output().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => {
            "Git is required but was not found on PATH. Install Git and try again.".into()
        }
        _ => format!("could not run Git: {e}"),
    })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(output.stdout)
}

fn path_from_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(PathBuf::from)
            .map_err(|_| "Git returned a non-UTF-8 path".into())
    }
}

fn untracked_diff(opt: &Options) -> Result<Vec<FileDiff>, String> {
    let root = git_output(git_command(opt).args(["rev-parse", "--show-toplevel"]))?;
    let root = path_from_bytes(root.strip_suffix(b"\n").unwrap_or(&root))?;
    let mut listing = git_command(opt);
    listing.args([
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
        "--",
    ]);
    // With no explicit separator, Git accepts both revisions and pathspecs.
    if !opt.path_separator {
        for arg in &opt.revisions {
            let revs = git_output(
                git_command(opt)
                    .args(["rev-parse", "--revs-only", "--no-flags"])
                    .arg(arg),
            )?;
            if revs.is_empty() {
                listing.arg(arg);
            }
        }
    }
    listing.args(&opt.paths);
    let paths = git_output(&mut listing)?;
    let mut files = Vec::new();
    for name in paths.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let relative = path_from_bytes(name)?;
        let path = root.join(&relative);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot inspect {}: {e}", path.display()))?;
        // Nested repositories are listed as directories; don't descend into them.
        if metadata.is_dir() {
            continue;
        }
        let (bytes, mode) = if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("cannot read link {}: {e}", path.display()))?;
            (target.as_os_str().as_encoded_bytes().to_vec(), "120000")
        } else if metadata.is_file() {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            (bytes, if executable { "100755" } else { "100644" })
        } else {
            return Err(format!(
                "unsupported untracked file type: {}",
                path.display()
            ));
        };
        let binary = bytes.iter().take(8000).any(|b| *b == 0);
        let mut patch = format!("new file mode {mode}\nUntracked file\n");
        let mut added = 0;
        if binary {
            patch.push_str("Binary file added; content is not displayed.\n");
        } else if !bytes.is_empty() {
            let content = String::from_utf8_lossy(&bytes);
            added = content.split_inclusive('\n').count();
            patch.push_str(&format!("@@ -0,0 +1,{added} @@\n"));
            for line in content.split_inclusive('\n') {
                patch.push('+');
                patch.push_str(line);
            }
            if !bytes.ends_with(b"\n") {
                patch.push_str("\n\\ No newline at end of file\n");
            }
        }
        files.push(FileDiff {
            path: relative.to_string_lossy().into_owned(),
            old_path: None,
            added,
            removed: 0,
            binary,
            patch,
        });
    }
    Ok(files)
}

// Git parses its native config syntax for us; includes are disabled so this file
// cannot load configuration from outside the selected project.
fn project_defaults(cli: &Options) -> Result<Options, String> {
    let mut defaults = Options {
        context: 3,
        ..Options::default()
    };
    if cli.no_config {
        return Ok(defaults);
    }
    let root = git_output(git_command(cli).args(["rev-parse", "--show-toplevel"]))?;
    let root = path_from_bytes(root.strip_suffix(b"\n").unwrap_or(&root))?;
    let path = root.join(".patchpane");
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(defaults),
        Err(e) => return Err(format!("cannot inspect {}: {e}", path.display())),
        Ok(_) => {}
    }
    let bytes = git_output(
        git_command(cli)
            .args(["config", "--null", "--list", "--no-includes", "--file"])
            .arg(&path),
    )?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("{}: configuration must be UTF-8", path.display()))?;
    let mut seen = std::collections::HashSet::new();
    for record in text.split('\0').filter(|r| !r.is_empty()) {
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        let invalid = |message: &str| format!("{}: {key}: {message}", path.display());
        if !seen.insert(key) {
            return Err(invalid("duplicate setting"));
        }
        let boolean = || match value {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(invalid("expected true or false")),
        };
        match key {
            "patchpane.open" => defaults.no_open = !boolean()?,
            "patchpane.new-report" => defaults.new_report = boolean()?,
            "patchpane.staged" => defaults.staged = boolean()?,
            "patchpane.include-untracked" => defaults.include_untracked = boolean()?,
            "patchpane.context" => {
                defaults.context = value
                    .parse::<u32>()
                    .ok()
                    .filter(|n| *n <= 100_000)
                    .ok_or_else(|| invalid("expected an integer between 0 and 100000"))?
            }
            "patchpane.output" | "patchpane.output-dir" => {
                if value.is_empty() {
                    return Err(invalid("path must not be empty"));
                }
                if key == "patchpane.output" && value == "-" {
                    defaults.output = Some(OsString::from("-"));
                } else {
                    let resolved = root.join(value);
                    if key == "patchpane.output" {
                        defaults.output = Some(resolved.into_os_string());
                    } else {
                        defaults.output_dir = Some(resolved);
                    }
                }
            }
            _ => return Err(invalid("unknown setting")),
        }
    }
    if defaults.output.is_some() && defaults.output_dir.is_some() {
        return Err(format!(
            "{}: choose either output or output-dir",
            path.display()
        ));
    }
    Ok(defaults)
}

fn unique_report_path(path: &std::path::Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut name = path
        .file_stem()
        .unwrap_or(std::ffi::OsStr::new("report"))
        .to_os_string();
    name.push(format!("-{}-{stamp}", std::process::id()));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    path.with_file_name(name)
}

fn write_report(path: &std::path::Path, content: &[u8], overwrite: bool) -> Result<(), String> {
    // Write beside the destination and rename only after the complete report is
    // written. Failed writes leave the previous report intact; symlinks aren't followed.
    let temporary = if overwrite {
        unique_report_path(path).with_extension("tmp")
    } else {
        path.to_path_buf()
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|e| format!("cannot create {}: {e}", temporary.display()))?;
    let result = file.write_all(content).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| {
        if overwrite {
            std::fs::rename(&temporary, path)
        } else {
            Ok(())
        }
    });
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let Some(cli) = options(args.clone().into_iter())? else {
        return Ok(());
    };
    let defaults = project_defaults(&cli)?;
    let opt = options_with_defaults(args.into_iter(), defaults)?.expect("help handled above");
    let mut git = Command::new("git");
    if let Some(dir) = &opt.repo {
        git.arg("-C").arg(dir);
    }
    // Override user diff presentation settings; never execute external diff/textconv helpers.
    git.args([
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--line-prefix=",
        "--output-indicator-new=+",
        "--output-indicator-old=-",
        "--output-indicator-context= ",
        "--find-renames",
        "--submodule=short",
        "--numstat",
        "-z",
        "--patch",
    ]);
    git.arg(format!("--unified={}", opt.context));
    if opt.staged {
        git.arg("--cached");
    }
    // Let Git distinguish bare paths from revisions unless the caller supplied --.
    git.args(&opt.revisions);
    if opt.path_separator {
        git.arg("--").args(&opt.paths);
    }
    let result = git_output(&mut git)?;
    let mut files = parse_diff(&result)?;
    if opt.include_untracked {
        files.extend(untracked_diff(&opt)?);
    }
    let comparison = if opt.revisions.is_empty() {
        if opt.staged {
            "Staged changes".into()
        } else {
            "Working tree".into()
        }
    } else {
        format!(
            "{}{}",
            opt.revisions
                .iter()
                .map(|r| r.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            if opt.staged { " · staged" } else { "" }
        )
    };
    let html = render(&comparison, &files);
    if opt.output.as_deref() == Some(std::ffi::OsStr::new("-")) {
        io::stdout()
            .lock()
            .write_all(html.as_bytes())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let path = if let Some(output) = opt.output {
        PathBuf::from(output)
    } else {
        let directory = match opt.output_dir {
            Some(directory) => directory,
            None => env::current_dir()
                .map_err(|e| format!("cannot determine current directory: {e}"))?
                .join("patchpane"),
        };
        std::fs::create_dir_all(&directory)
            .map_err(|e| format!("cannot create {}: {e}", directory.display()))?;
        directory.join("report.html")
    };
    let path = if opt.new_report {
        unique_report_path(&path)
    } else {
        path
    };
    write_report(&path, html.as_bytes(), !opt.new_report)?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    eprintln!(
        "{} files (+{} −{}) → {}",
        files.len(),
        files.iter().map(|f| f.added).sum::<usize>(),
        files.iter().map(|f| f.removed).sum::<usize>(),
        path.display()
    );
    if !opt.no_open
        && let Err(e) = open_browser(&path)
    {
        eprintln!("patchpane: browser could not open ({e}); open the HTML file manually");
    }
    Ok(())
}

fn open_browser(path: &std::path::Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    let status = cmd.arg(path).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("opener exited with {status}")))
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("patchpane: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_overrides_boolean_defaults_in_both_directions() {
        let defaults = Options {
            no_open: true,
            staged: true,
            include_untracked: true,
            context: 8,
            ..Options::default()
        };
        let opt = options_with_defaults(
            [
                "--open",
                "--unstaged",
                "--no-include-untracked",
                "--context",
                "0",
            ]
            .into_iter()
            .map(OsString::from),
            defaults,
        )
        .unwrap()
        .unwrap();
        assert!(!opt.no_open && !opt.staged && !opt.include_untracked);
        assert_eq!(opt.context, 0);
        let opt = options_with_defaults(
            ["--no-open", "--staged", "--include-untracked"]
                .into_iter()
                .map(OsString::from),
            opt,
        )
        .unwrap()
        .unwrap();
        assert!(opt.no_open && opt.staged && opt.include_untracked);
    }

    #[test]
    fn escape_script_and_controls() {
        assert_eq!(
            json("</script>\n\"\\\t"),
            "\"\\u003c/script>\\u000a\\\"\\\\\\u0009\""
        );
    }
    #[test]
    fn rejects_options_and_excess_revisions() {
        for args in [
            vec!["--wat"],
            vec!["--context", "x"],
            vec!["--staged", "a", "b"],
            vec!["a", "b", "c"],
        ] {
            assert!(options(args.into_iter().map(OsString::from)).is_err());
        }
    }
    #[test]
    fn paths_after_separator_are_literal() {
        let o = options(["--", "-strange", "a b"].into_iter().map(OsString::from))
            .unwrap()
            .unwrap();
        assert_eq!(o.paths.len(), 2);
    }
    #[test]
    fn parses_rename_with_hostile_filename() {
        let f = parse_diff(
            b"2\t1\t\0old\tname\0new\nname\0\0diff --git anything\n@@ -1 +1 @@\n-x\n+y\n",
        )
        .unwrap();
        assert_eq!(f[0].path, "new\nname");
        assert_eq!(f[0].old_path.as_deref(), Some("old\tname"));
        assert_eq!(f[0].added, 2);
    }
    #[test]
    fn rejects_malformed_input() {
        assert!(parse_diff(b"garbage").is_err());
        assert!(parse_diff(b"1\t1\ta\0\0").is_err());
    }
}
