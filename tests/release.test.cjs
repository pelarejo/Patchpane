const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchpane-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git'), bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(repo, 'tooling'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, '../tooling/hb-release.sh'), path.join(repo, 'tooling/hb-release.sh'));
  fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\nname = "patchpane"\nversion = "0.1.3"\n\n[dependencies]\n');
  fs.writeFileSync(path.join(repo, 'Cargo.lock'), 'version = "0.1.3"\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('add', '.'); git('commit', '-qm', 'Fixture');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'main');
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "' + name + ' $*" >> "$RELEASE_LOG"\n' + body + '\n', { mode: 0o755 });
  script('cargo', `if [[ $1 == clippy ]]; then
    if [[ "\${FAIL_CHECK:-}" == yes ]]; then exit 1; fi
    awk '/^version =/ {print; exit}' Cargo.toml > Cargo.lock
  fi`);
  script('node', ':');
  script('curl', 'while [[ $# -gt 0 ]]; do if [[ $1 == --output ]]; then printf archive > "$2"; exit 0; fi; shift; done; exit 1');
  script('brew', ':');
  script('gh', 'if [[ $1 == pr && $2 == view ]]; then printf "abc123\\n"; fi');
  const log = path.join(dir, 'commands');
  const run = (args, input, env = {}) => spawnSync('bash', ['tooling/hb-release.sh', ...args], {
    cwd: repo, input, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RELEASE_LOG: log, ...env },
  });
  const commands = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { repo, remote, git, run, commands };
}

test('guided patch release updates both Cargo files and atomically publishes main and tag', t => {
  const f = fixture(t);
  const out = f.run([], '\ny\ny\nn\nn\n');
  assert.equal(out.status, 0, out.stderr);
  assert.match(fs.readFileSync(path.join(f.repo, 'Cargo.toml'), 'utf8'), /version = "0.1.4"/);
  assert.match(fs.readFileSync(path.join(f.repo, 'Cargo.lock'), 'utf8'), /version = "0.1.4"/);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('log', '-1', '--format=%s'), 'Release v0.1.4');
  assert.equal(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'refs/tags/v0.1.4'], { encoding: 'utf8' }).trim(), f.git('rev-parse', 'HEAD'));
  assert.match(out.stdout, /sha256 "[a-f0-9]{64}"/);
  assert.match(f.commands(), /cargo test --locked/);
  assert.match(f.commands(), /node --test tests\/viewer.test.cjs/);
  assert.match(out.stdout, /Next steps in your pelarejo\/homebrew-tap checkout/);
});

for (const where of ['local', 'remote']) {
  test(`existing ${where} tag fails before builds or file edits`, t => {
    const f = fixture(t);
    f.git('tag', 'v0.1.4');
    if (where === 'remote') { f.git('push', '-q', 'origin', 'v0.1.4'); f.git('tag', '-d', 'v0.1.4'); }
    const out = f.run(['0.1.4'], 'y\ny\n');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /already exists/);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(f.commands(), '');
  });
}

test('minor, major and custom version choices can be cancelled without mutation', t => {
  const f = fixture(t);
  for (const [choice, version] of [['minor', '0.2.0'], ['major', '1.0.0'], ['v0.3.2', '0.3.2']]) {
    const out = f.run([], `${choice}\nn\n`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`Release v${version.replaceAll('.', '\\.')}:`));
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(f.commands(), '');
  }
});

test('invalid or lower versions and a dirty checkout do not publish', t => {
  const f = fixture(t);
  for (const version of ['invalid', '0.01.4', '0.1.2']) assert.notEqual(f.run([version], 'y\ny\n').status, 0);
  fs.writeFileSync(path.join(f.repo, 'uncommitted'), 'keep me');
  assert.notEqual(f.run(['0.1.4'], 'y\ny\n').status, 0);
  assert.equal(f.git('tag', '--list'), '');
  assert.equal(f.commands(), '');
});

test('failed checks leave version edits for review without creating a tag', t => {
  const f = fixture(t);
  const out = f.run(['0.1.4'], 'y\ny\n', { FAIL_CHECK: 'yes' });
  assert.notEqual(out.status, 0);
  assert.equal(f.git('tag', '--list'), '');
  assert.match(out.stderr, /Stopped while/);
  assert.match(f.git('diff'), /0\.1\.4/);
  assert.doesNotMatch(f.commands(), /curl/);
});

test('cancelling publication keeps checked version edits but does not commit or tag', t => {
  const f = fixture(t);
  const out = f.run(['0.1.4'], 'y\nn\n');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(f.git('tag', '--list'), '');
  assert.equal(f.git('log', '-1', '--format=%s'), 'Fixture');
  assert.match(f.git('diff'), /0\.1\.4/);
  assert.doesNotMatch(f.commands(), /curl/);
});

test('current version can be released without making an empty version commit', t => {
  const f = fixture(t);
  const out = f.run(['current'], 'y\ny\n');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(f.git('tag', '--list'), 'v0.1.3');
  assert.equal(f.git('log', '-1', '--format=%s'), 'Fixture');
});

test('release ends with a manual Homebrew handoff and never invokes brew or gh', t => {
  const f = fixture(t);
  const out = f.run(['0.2.0'], 'y\ny\n');
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(f.commands(), /^(gh|brew) /m);
  assert.doesNotMatch(out.stdout, /gh release create/);
  assert.match(out.stdout, /git switch -c patchpane-0\.2\.0/);
  assert.match(out.stdout, /git commit -m "chore\(patchpane\): bump to 0\.2\.0"/);
  assert.match(out.stdout, /Edit Formula\/patchpane\.rb/);
  assert.match(out.stdout, /previous bottle block/);
  assert.match(out.stdout, /gh pr create --repo pelarejo\/homebrew-tap/);
  assert.match(out.stdout, /publish\.yml/);
});

for (const args of [['--dry-run', '0.2.0'], ['0.2.0', '--dry']]) {
  test(`simulation ${args.join(' ')} performs no writes or external commands`, t => {
    const f = fixture(t);
    f.git('tag', 'v0.2.0'); // Simulation also works with dirty files and existing tags.
    fs.writeFileSync(path.join(f.repo, 'uncommitted'), 'keep me');
    const head = f.git('rev-parse', 'HEAD');
    const status = f.git('status', '--porcelain');
    const manifest = fs.readFileSync(path.join(f.repo, 'Cargo.toml'), 'utf8');
    const lock = fs.readFileSync(path.join(f.repo, 'Cargo.lock'), 'utf8');
    // Any accidentally executed release tool (including git) fails and records its call.
    const bin = path.join(path.dirname(f.repo), 'bin');
    for (const tool of ['git', 'cargo', 'node', 'curl', 'shasum', 'gh', 'brew', 'mktemp']) {
      fs.writeFileSync(path.join(bin, tool), '#!/usr/bin/env bash\nprintf "%s\\n" "unexpected command" >> "$RELEASE_LOG"\nexit 99\n', { mode: 0o755 });
    }
    const out = f.run(args, 'y\ny\n');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(f.commands(), '');
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.git('status', '--porcelain'), status);
    assert.equal(f.git('tag', '--list'), 'v0.2.0');
    assert.equal(fs.readFileSync(path.join(f.repo, 'Cargo.toml'), 'utf8'), manifest);
    assert.equal(fs.readFileSync(path.join(f.repo, 'Cargo.lock'), 'utf8'), lock);
    assert.match(out.stdout, /\[dry\] git push --atomic/);
    assert.match(out.stdout, /Next steps in your pelarejo\/homebrew-tap checkout/);
    assert.doesNotMatch(out.stdout, /\[dry\] (gh|brew) /);
    assert.match(out.stdout, /Checks were simulated, not executed/);
    assert.match(out.stdout, /Dry run complete/);
    assert.doesNotMatch(out.stdout + out.stderr, /\u001b\[/);
  });
}
