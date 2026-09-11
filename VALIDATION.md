# Verification

- 17 automated tests passed with a fake Claude process and real temporary Git repositories.
- The installed skill passed Codex skill validation.
- A read-only `skills/list` request to the installed Codex app server discovered Claudex as an enabled user skill with no loading errors.
- `claudex doctor` confirmed first-party `claude.ai` authentication and a Max subscription.
- A native Claude implementation worker completed a scoped change in an isolated test repository. Codex inspected the patch, verified the original file was unchanged, applied it with Git, and checked empty, nonempty, and negative inputs. The uncommitted user comment and Git index were preserved.

Live implementation artifacts: `/home/astrosteveo/.local/state/claudex/runs/20260908-210446-f48d627e82`. Provider metadata identified `claude-opus-5[1m]` for the implementation response.

A native Claude review completed in seven turns. Codex reproduced three of its findings as failing tests: an inherited Git index override mutated the test repository's index, text attributes normalized snapshot bytes, and an ASCII locale broke UTF-8 task input. Codex corrected them by clearing inherited Git overrides, neutralizing snapshot conversion attributes, and using explicit UTF-8 encoding. All three regression checks now pass.

Codex also expanded CLI flag checks and added safe compatibility diagnostics. The review's uncertainty about the native JSON auth contract was resolved by the successful real doctor and worker calls. The executable bit and native permission-denials field were checked. The final corrections were validated by tests; Claude did not perform a second review of the corrected revision.

Independent review artifacts: `/home/astrosteveo/.local/state/claudex/runs/20260908-210411-0aef71d655`.

Automated checks do not establish model-routing quality for every future prompt. Remaining quota is not exposed by the bridge. The implementation snapshot limits are documented in README.md.

## 0.2.0: Claude Code as lead, Codex as worker

- 35 automated tests passed with fake Claude and Codex processes and real temporary Git repositories, including the 17 earlier tests unchanged in behavior.
- `claudex doctor` (Claude) and `claudex doctor --worker codex` both reported `ready` on this machine without inference: Claude Code 2.1.268 with `claude.ai` Max login; Codex CLI 0.154.0 with ChatGPT login.
- `codex debug prompt-input` (a local render of the model-visible prompt, no inference) established on Codex 0.154.0 that `-c developer_instructions` is delivered as the first developer message and that `skills.config=[{path=".../skills/claudex/SKILL.md", enabled=false}]` hides the Claudex skill while the `imagegen` system skill remains. It also showed that Codex offers no switch for the global `$CODEX_HOME/AGENTS.md`. Earlier iterations of this release added sandbox, approval, feature, MCP, and config-loading overrides to the worker; the user asked for their Codex configuration to apply unchanged, so those were removed and the worker now runs with `config.toml` as is (see the smoke test below). The two live runs recorded next were made with the earlier guarded command line.
- `python3 install.py` (default both leads) migrated the pre-existing `~/.codex/skills/claudex` link from the 0.1.0 layout, linked `~/.claude/skills/claudex`, and wrote the Claude-lead block to `~/.claude/CLAUDE.md`; the regenerated Codex block was byte-identical, so no AGENTS.md backup was needed.
- A native Codex `review` worker (`/home/astrosteveo/.local/state/claudex/runs/20260910-214941-8adbdc5cae`) completed in 34 seconds. Its handoff opened with "Claude Code leads this collaboration", confirming the developer instructions reach the model under `--ignore-user-config`; it ran `nl`, `rg`, and `python` read-only in the sandbox and found the seeded even-length median bug with a failing input. The source repository and its uncommitted edit were untouched. The JSONL events (`thread.started`, `turn.started`, `item.started/completed` with `command_execution`, `agent_message`, `file_change`, `turn.completed` with usage) matched the bridge's parser.
- A native Codex `implement` worker (`/home/astrosteveo/.local/state/claudex/runs/20260910-215038-dd379ffb94`) completed in 64 seconds with `--allow-file src/stats.py --allow-file assets/stone-texture.png`. It fixed the median function and generated a 1254x1254 cobblestone texture through the built-in `image_gen` tool of the `imagegen` skill, copied it from `~/.codex/generated_images/` into the snapshot, and reported the default built-in mode. The 4.9 MB binary patch passed `git apply --check`, applied to the source repository, and the uncommitted `# TODO` comment survived; `median([1, 2])` returned `1.5` afterwards. No commands failed and no denials were recorded.

`codex exec --json` does not name the model in its events; with user configuration ignored, the worker used Codex's built-in default. Codex reports token usage only, so `result.json` carries no cost figure for Codex runs. Remaining ChatGPT quota is not exposed by the bridge.

Smoke test after removing the overrides: a native Codex `consult` worker (`/home/astrosteveo/.local/state/claudex/runs/20260910-220713-64326b30a4`) completed in 17 seconds under the user's own `config.toml`. It reported that Claude Code leads, that it runs with `danger-full-access` and `approval_policy = never` (the user's settings, not bridge defaults), that web, image-generation, and MCP tools are available, that `claudex` is absent from its skill list while `imagegen` is present, and that it identifies as GPT-6 Codex; the exact variant and reasoning effort are not exposed to the model or the event stream, so they follow from `config.toml` (`gpt-6-astra`, `xhigh`) being loaded unchanged.

Read-only change detection was added after the smoke test: the fake Codex rewrites a tracked file, adds an untracked one, deletes another, and writes an ignored cache during a review; the run stays `complete`, `source_changes` lists exactly the three unignored paths, and a warning is printed. A non-Git folder reports `source_changes: null`.
