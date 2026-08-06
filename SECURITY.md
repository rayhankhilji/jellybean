# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/rayhankhilji/jellybean/security/advisories/new)
rather than opening a public issue.

Include what you were running (`jellybean --version`), the platform, and the
smallest set of steps that shows the problem. If you have a workspace layout or
a client configuration that triggers it, that is the most useful thing you can
send.

You should get an acknowledgement within a few days. Once a fix is out, you are
credited in the release notes unless you would rather not be.

## What Jelly Bean is trusted with

It is worth being precise about this, because the threat model is unusual: the
untrusted input is not a remote attacker, it is **the model driving the tools**
and **the contents of the repository being indexed**. Both can be influenced by
someone other than the person running the server.

Jelly Bean therefore treats every tool argument as hostile, and every file it
reads as data rather than instruction.

### It does not invoke a shell

`jb_diagnose` is the only tool that executes anything. Commands are spawned with
an argv array and `shell: false`. There is no globbing, no `$(…)`, no `;`
chaining, no redirection. A `command` of `echo hi; rm -rf /` runs `echo` with
the literal arguments `hi;`, `rm`, `-rf`, `/`, and fails harmlessly.

Windows needs care here, because `npm` is `npm.cmd` and cannot be spawned
directly. Jelly Bean invokes `cmd.exe` explicitly with a self-quoted command
line and **rejects arguments containing shell metacharacters** rather than
setting `shell: true`, which would reintroduce exactly the injection surface the
rest of this design removes.

### It runs only what the project declares

By default the runnable set is discovered from the repository itself: npm
scripts, Make targets, and language defaults for cargo, go, pytest, and tsc.
Nothing else can be run.

Two flags widen that, and both are opt-in from the command line — a tool call
cannot grant itself either:

- `--allow-command "<cmd>"` permits one command, prefix-matched, and is
  repeatable.
- `--unsafe-commands` permits anything. It exists for people who genuinely want
  it and know why. `--doctor` reports it as a warning.

Runs are killed after 120 seconds by default (`--command-timeout`) and captured
output is capped at 2 MB.

### It cannot read outside the workspace

Every caller-supplied path goes through one function, `Workspace.resolve`, which
resolves the path and rejects anything landing outside the root. There is no
second way in — tools do not open files by any other route.

Symlinks are skipped during walks. They can point outside the tree, and they can
create cycles.

### It does no network I/O

None. There is no telemetry, no update check, and no remote fetch of any kind.

### What it writes

Two things, and nothing else:

- `.jellybean/notes.json` inside the workspace, when `jb_notes` is asked to save
  something.
- A parse cache outside the workspace, under `XDG_CACHE_HOME` or
  `~/.cache/jellybean/`, keyed by a hash of the workspace path. It holds parse
  output: declaration names and signatures, the first line of each doc comment,
  import specifiers, and term counts. Signatures and doc lines are literal
  fragments of your source, so treat the cache as derived from the code and not
  as free of it — but it never holds a file body.

`jellybean --doctor` prints both locations for a given workspace.

## Known limits

These are design decisions rather than oversights, but you should know about
them.

- **Tool output is untrusted text going to a model.** Jelly Bean returns source
  code, and source code can contain text written to influence an agent reading
  it. Nothing here sanitises that, and nothing could without mangling the code.
  Treat tool output the way you would treat the repository itself.
- **`jb_diagnose` runs project-declared commands.** Cloning a hostile repository
  and pointing Jelly Bean at it means its `package.json` scripts are runnable by
  a tool call. This is the same exposure as running `npm test` in that
  repository, but it is worth stating plainly, because a tool call is easier to
  trigger than a deliberate `npm test`.
- **The parse cache is keyed by (path, size, mtime).** A file changed without
  its size or mtime changing would be served from cache. This matters for
  correctness rather than security, but it is the kind of assumption worth
  writing down.

## Supported versions

The latest released minor version receives security fixes.
