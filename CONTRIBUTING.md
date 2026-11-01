# Contributing and repository conventions

## Language

Write repository documentation, issue descriptions, pull requests, and new commit messages in English. Keep product localization, API field names, file paths used by code, and quoted source material in their required form. Do not rewrite Git history to translate old commits.

## New files

1. Search for an existing file covering the same responsibility.
2. Place implementation files in the component that owns them; follow its existing framework conventions.
3. Put technical guides and decisions under `docs/`. Use short, descriptive English filenames, normally `kebab-case.md`.
4. Keep the root README focused on purpose, status, verified setup, and navigation.
5. Link each new guide from its component README or documentation index.

Use `src/`, `tests/`, `docs/`, `scripts/`, and `assets/` when they fit a new project. Existing framework layouts take precedence; do not add empty directories just to match a template. Date-prefix chronological records with `YYYY-MM-DD`.

## Changes

- Describe the concrete problem and resulting behavior.
- Keep unrelated changes separate and use descriptive branch names.
- Record only validation that was actually performed; distinguish planned features from implemented behavior.
- Update the relevant guide when commands, configuration, or behavior change.
- Run checks appropriate to the change. Documentation-only edits need link and instruction review; they do not prove that the application has been tested.
- Prefer concise commit messages such as `docs: clarify local setup` or `fix: handle empty input`.

## Project records

Code and its technical documentation belong in GitHub. Personal planning and learning notes belong in Obsidian and link to their repository. Avoid maintaining the same technical guide in both places.

## Private files and attribution

Keep live credentials, private environment files, generated access lists, and local workspace state out of Git. Preserve required upstream licenses and attribution. Document new configuration through examples with placeholders.
