# Publication checklist

Everything here is a **repository setting or an external action**, not code.
That is the whole reason this file exists: `git archive` moves the tree and
nothing else. Branch protection, secret scanning, Actions permissions, labels,
issues and release tags all stay behind in the repository they were configured
in, and have to be set up again by hand in the new one.

Work top to bottom. The order matters in two places, noted where it does.

## 1. Before the tree moves

- [ ] **Confirm nothing in the tree is secret.** Not "no `.env`" — read the
      tracked file list. `git ls-files | xargs grep -nEi "api[_-]?key|secret|token|password\s*="`
      and read every hit rather than trusting a clean exit code.
- [ ] **Confirm the working tree is the tree you want published.** `git archive`
      exports `HEAD`, so anything uncommitted is dropped and anything committed
      is published, including files you meant to delete later.
- [ ] **Decide about `.claude/`.** 36 files are tracked and will be published:
      agent definitions, skills, the GitNexus-generated per-area skill files,
      and `settings.json`. `settings.local.json` is *not* tracked, so the
      machine-specific allow-list does not ship — verify that is still true
      rather than assuming, since it is one `git add -f` away from being wrong.
      Nothing in the tracked set carries a home-directory path or a credential
      today.

## 2. Issue references in the tree

Measured on `main`:

| | Count |
| --- | --- |
| Full `https://github.com/anonhym/mongo-lab/issues/nnn` links | 45 |
| Bare `#nnn` references in docs, specs and code comments | ~1249 |
| Distinct issue numbers referenced | 329 |
| Issues open in the source repository | 171 |

### What GitHub actually does with them

Verified rather than assumed, because the obvious guess is wrong and it
changes the whole shape of this section:

| Where the reference sits | Auto-links? |
| --- | --- |
| A Markdown file rendered in the repository | **No** |
| A source-code comment | **No** |
| An issue, pull request, comment or commit message | **Yes** |

Check it the same way if you ever need to: render the file through
`gh api repos/<owner>/<repo>/contents/<file> -H "Accept: application/vnd.github.html"`
and grep for `issue-link`. `CLAUDE.md` renders `#382` three times as plain text
with zero `issue-link` elements; the identical string through
`gh api /markdown` in `gfm` mode does produce one. Keep the positive control —
a grep that finds nothing looks exactly like a grep that is broken.

So a bare `#nnn` in the tree is **inert text**. It does not become a link to an
unrelated issue in the new repository. What it becomes is a reference a reader
cannot resolve, citing a tracker they cannot see.

Only the 45 full URLs actually break, and they break visibly.

### The decision

Because nothing here is load-bearing, remapping the numbers is optional and
recreating 171 issues to build a remap table buys very little. Removing them is
the cheaper end state and the better one: a reference to a tracker that no
longer exists does not become right by being renumbered.

**Outcome for code comments.** The references in `src/` and `tests/` turned
out not to be mongo-lab numbers. The tracker here restarted at #1 after the
Sept 15 import, and each code-comment reference was checked against it: 34 of
the 36 distinct numbers are this repository's own issues, each created before
the comment that cites it, with titles that match. They stay, and CLAUDE.md
now allows issue numbers in comments. The two that did come over in the
import, `#324` and `#482` in `src/index.css`, were removed.

`git grep -nE "github\.com/[^/]+/[^/]+/issues/[0-9]+"` finds the links, and
`git grep -nE "(^|[^a-zA-Z0-9/_#-])#[0-9]{2,4}"` finds the bare references.
Two traps in that second pattern:

- Do not use `\b`. git grep's engine drops it silently and reports almost
  nothing, which reads exactly like a clean tree.
- It matches three-digit hex colours — `{ fg: '#666' }` — so anything acting on
  its output must require the match to sit inside a comment.

## 3. Repository settings on the new repo

### Security

- [ ] **Secret scanning** — on. Settings → Code security.
- [ ] **Push protection** — on. This is the one that actually stops a leak,
      by rejecting the push rather than alerting after the fact. Free on public
      repositories.
- [ ] **Private vulnerability reporting** — on. `SECURITY.md` and the issue
      template's contact link both point at
      `/security/advisories/new`, which 404s until this is enabled.
- [ ] **Dependabot alerts and security updates** — on. There are open alerts
      against this dependency tree today; triage them before or immediately
      after publication, and note that `npm audit` undercounts against what
      Dependabot reports on the same lockfile. What is open right now is two
      moderate `qs` advisories, and they are **not** a publication blocker:
      `npm ls --omit=dev typed-rest-client` is empty, so the path runs only
      through `@stryker-mutator/core` and never ships. `typed-rest-client`
      pins `qs` at an exact version, so clearing them needs an `overrides`
      entry — optional, and the maintainer's call rather than a gate.

### Branch protection on `main`

- [ ] Require a pull request before merging.
- [ ] Require status checks to pass — select the CI jobs **after** the first
      workflow run on the new repository, because a check that has never run
      cannot be selected by name. There are five, not two: `e2e` is a matrix,
      so it reports as `Playwright + Electron (1/4)` through `(4/4)` and every
      shard must be selected. Selecting some of them protects nothing —
      an unselected shard can go red and the merge still proceeds.
      Know the other edge before you turn this on: CI has a `paths` filter
      that skips a Markdown-only change, and a required check that never
      runs sits pending forever rather than passing. A docs PR will need a
      merge override, or the filter has to go. Five checks make that five
      times as visible as it used to be.
- [ ] Require branches to be up to date before merging.
- [ ] Require review from Code Owners — `CODEOWNERS` has no effect without this.
- [ ] Block force pushes and deletions.

Note that a solo maintainer who enables "require a pull request" is also
blocking themselves from pushing to `main` directly. That is the point, but
decide it deliberately.

### Actions

- [ ] **Workflow permissions** → read-only by default. Individual workflows
      already declare what they need.
- [ ] **Fork pull requests** — require approval for all outside collaborators.
      This is load-bearing for the AI workflows below.
- [ ] Add the `CLAUDE_CODE_OAUTH_TOKEN` secret if `claude.yml` and
      `claude-code-review.yml` are kept.
- [ ] Add the five macOS signing and notarization secrets; `release.yml` fails
      the macOS job if any is empty:
      - `CSC_LINK` — base64 of the Developer ID Application certificate `.p12`.
      - `CSC_KEY_PASSWORD` — the password of that `.p12`.
      - `APPLE_API_KEY` — the contents of the App Store Connect API key `.p8`
        (the workflow writes it to a file and points electron-builder at it).
      - `APPLE_API_KEY_ID` — the Key ID of that API key.
      - `APPLE_API_ISSUER` — the Issuer ID shown on the App Store Connect
        Keys page.

      Windows builds stay unsigned; no `WIN_*` secret is read.

### The AI workflows — read this before re-arming either

`claude.yml` and `claude-code-review.yml` run Claude against repository content
with a token. On a public repository, **anyone who can open a pull request or
write a comment can reach them**. Both carry a guard comment explaining the
author-association check they need; do not remove the triggers' gating without
reading it.

The failure modes are asymmetric and easy to get backwards:

- A comparison against a **wrong or missing** event field evaluates to `null`,
  `null == 'OWNER'` is false, and the job is skipped. That fails **closed** —
  annoying, safe.
- A **deny-list** inversion such as `author_association != 'NONE'` is true for
  every value including a missing one. That fails **open**.

Prefer an allow-list of associations. Verify by opening a pull request from an
account that is not a collaborator and confirming nothing runs.

### Other

- [ ] Recreate the `priority:P0/P1/P2`, `effort:S/M/L` and triage labels
      (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
      `wontfix`) before recreating issues, or the issues arrive unlabelled.
- [ ] Decide whether to enable **Discussions**. The issue-template config
      deliberately does not link to it, because it is off today.
- [ ] Add repository topics and a description — these are what make the
      project findable.

## 4. After publication

- [ ] Verify `SECURITY.md`'s advisory link resolves.
- [ ] Verify the in-app troubleshooting link resolves —
      `src/troubleshooting/repoUrl.ts` deep-links into
      `docs/troubleshooting.md` on the default branch, and it has been pointing
      at a repository the end user cannot open.
- [ ] Run the full Definition of done once on the published tree. A fresh clone
      installing from scratch is the case no local run covers.
- [ ] Tag a release. Tags do not travel with `git archive`; `CHANGELOG.md`
      carries the history, and the tags themselves start again from whatever
      the first published version is. The tag must be `v` plus the
      `package.json` version (`v0.17.1` for `0.17.1`): `release.yml` fails
      before building otherwise.
