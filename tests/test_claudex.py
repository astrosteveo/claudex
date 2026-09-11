import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import claudex
import install


FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
if "--version" in args:
    print("2.1.266 (Fake Claude Code)")
elif "--help" in args:
    print("--restricted --safe-mode --permission-prompts --setting-sources --strict-mcp-config --mcp-config --settings --print --output-format --permission-mode --tools --allowedTools --disallowedTools --no-session-persistence --append-system-prompt --model")
elif "auth" in args:
    logged = os.environ.get("TEST_AUTH", "ready") != "missing"
    print(json.dumps({"loggedIn": logged, "authMethod": "api_key" if os.environ.get("TEST_AUTH") == "api" else "claude.ai", "apiProvider": "firstParty"}))
    sys.exit(0 if logged else 1)
else:
    brief = sys.stdin.read()
    mode = os.environ.get("TEST_BEHAVIOR", "success")
    capture = os.environ.get("TEST_CAPTURE")
    if capture:
        pathlib.Path(capture).write_text(json.dumps({"args":args,"brief":brief,"cwd":os.getcwd(),"pid":os.getpid(),"provider_env":{k:v for k,v in os.environ.items() if k.startswith(("ANTHROPIC_","CLAUDE_","CLAUDEX_"))}}))
    if mode == "timeout":
        time.sleep(30)
    if mode == "implement":
        p=pathlib.Path("src/app.py")
        p.write_text(p.read_text()+"\n# contribution from Claude\n")
        pathlib.Path("new.py").write_text("ADDED = True\n")
    if mode == "out_of_scope":
        pathlib.Path("unassigned.txt").write_text("Unrequested change\n")
    if mode == "empty":
        print("unexpected output")
        sys.exit(1)
    result={"type":"result","subtype":"success","is_error":False,"result":"Focused handoff based on the supplied context.","num_turns":2,"usage":{"input_tokens":25,"output_tokens":10},"modelUsage":{"fake-claude":{"inputTokens":25}},"total_cost_usd":0.01,"permission_denials":[]}
    if mode == "limit":
        result.update(is_error=True,subtype="error_during_execution",result="You've hit your limit. Try again later.")
    if mode == "max_turns":
        result.update(is_error=True,subtype="error_max_turns",result="Incomplete: max turns reached.")
    if mode == "denial":
        result["permission_denials"]=[{"tool_name":"Bash","tool_use_id":"test"}]
    if mode == "unicode":
        result["result"]="Useful review \u2014 \u03b1 and \U0001f680"
        sys.stdout.buffer.write((json.dumps(result,ensure_ascii=False)+"\n").encode("utf-8"))
    else:
        print(json.dumps(result))
    sys.exit(1 if result["is_error"] else 0)
'''

FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
if "--version" in args:
    print("codex-cli 0.154.0 (Fake Codex)")
elif args[:2] == ["exec", "--help"]:
    print("--json --output-last-message --sandbox --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --cd --color --model --config --disable")
elif args[:2] == ["login", "status"]:
    auth = os.environ.get("TEST_AUTH", "ready")
    if auth == "missing":
        print("Not logged in", file=sys.stderr)
        sys.exit(1)
    print("Logged in using an API key" if auth == "api" else "Logged in using ChatGPT", file=sys.stderr)
else:
    brief = sys.stdin.buffer.read().decode("utf-8") if args[-1] == "-" else ""
    mode = os.environ.get("TEST_BEHAVIOR", "success")
    capture = os.environ.get("TEST_CAPTURE")
    if capture:
        pathlib.Path(capture).write_text(json.dumps({"args":args,"brief":brief,"cwd":os.getcwd(),"pid":os.getpid(),"provider_env":{k:v for k,v in os.environ.items() if k.startswith(("OPENAI_","CODEX_","CLAUDEX_"))}}), encoding="utf-8")
    if mode == "timeout":
        time.sleep(30)
    if mode == "implement":
        p=pathlib.Path("src/app.py")
        p.write_text(p.read_text()+"\n# contribution from Codex\n")
        pathlib.Path("new.py").write_text("ADDED = True\n")
    if mode == "out_of_scope":
        pathlib.Path("unassigned.txt").write_text("Unrequested change\n")
    if mode == "edit_source":
        pathlib.Path("src/app.py").write_text("VALUE = 'rewritten by the worker'\n")
        pathlib.Path("tampered.txt").write_text("unrequested\n")
        pathlib.Path("untracked.py").unlink()
        pathlib.Path("__pycache__").mkdir(exist_ok=True)
        pathlib.Path("__pycache__/ignored.pyc").write_text("cache")
    if mode == "empty":
        print("unexpected output")
        sys.exit(1)
    text = "Useful review — α and \U0001f680" if mode == "unicode" else "Focused handoff based on the supplied context."
    events = [{"type":"thread.started","thread_id":"thread_fake"},{"type":"turn.started"}]
    if mode == "denial":
        events.append({"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"curl example.com","status":"declined","exit_code":None}})
    events.append({"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pytest","status":"failed","exit_code":1,"aggregated_output":"no tests ran"}})
    failed = mode == "limit"
    if failed:
        events.append({"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again later."}})
    else:
        events.append({"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":text}})
        events.append({"type":"turn.completed","usage":{"input_tokens":25,"cached_input_tokens":5,"output_tokens":10}})
        if "--output-last-message" in args:
            pathlib.Path(args[args.index("--output-last-message")+1]).write_text(text, encoding="utf-8")
    for event in events:
        sys.stdout.buffer.write((json.dumps(event,ensure_ascii=False)+"\n").encode("utf-8"))
    sys.exit(1 if failed else 0)
'''


class BridgeCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="claudex-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name, script in (("claude", FAKE_CLAUDE), ("codex", FAKE_CODEX)):
            fake = self.bin / name
            fake.write_text(script)
            fake.chmod(0o755)
        self.project = self.base / "project with spaces"
        self.project.mkdir()
        self.brief = self.base / "brief.md"
        self.brief.write_text("Review the implementation. Literal $(do-not-run) and `not-a-command`.\n")
        self.capture = self.base / "capture.json"
        self.env = {
            **os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "XDG_STATE_HOME": str(self.base / "state"), "TEST_CAPTURE": str(self.capture),
        }

    def invoke(self, *args, **env):
        result = subprocess.run(
            [sys.executable, str(ROOT / "claudex.py"), *args],
            env={**self.env, **env}, capture_output=True, text=True, timeout=15,
        )
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            self.fail(f"Not a JSON handoff: {result.stdout}\n{result.stderr}")
        return result, payload

    def run_worker(self, *extra, **env):
        return self.invoke("run", "--project", str(self.project), "--prompt-file", str(self.brief), *extra, **env)

    def git(self, *args):
        return claudex.git(self.project, *args)

    def create_repo(self):
        self.git("init", "--quiet")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@localhost")
        (self.project / "src").mkdir()
        (self.project / "src/app.py").write_text("VALUE = 'committed'\n")
        (self.project / "deleted.txt").write_text("Delete me\n")
        (self.project / ".gitignore").write_text(".env\ndependencies/\n")
        self.git("add", ".")
        self.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Base")
        (self.project / "src/app.py").write_text("VALUE = 'staged'\n")
        self.git("add", "src/app.py")
        (self.project / "src/app.py").write_text("VALUE = 'working tree'\n")
        (self.project / "deleted.txt").unlink()
        (self.project / "untracked.py").write_text("UNTRACKED = True\n")
        (self.project / ".env").write_text("SECRET=not-shared\n")
        (self.project / "dependencies").mkdir()
        (self.project / "dependencies/large.bin").write_bytes(b"not copied")


class IntegrationTests(BridgeCase):
    def test_doctor_does_not_send_an_inference_request(self):
        result, payload = self.invoke("doctor")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["status"], "ready")
        self.assertFalse(self.capture.exists())

    def test_missing_or_api_auth_never_starts_worker(self):
        for auth in ("missing", "api"):
            with self.subTest(auth=auth):
                result, payload = self.run_worker(TEST_AUTH=auth)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(payload["status"], "needs_auth")
                self.assertFalse(self.capture.exists())

    def test_consult_is_read_only_and_passes_literal_prompt_on_stdin(self):
        result, payload = self.run_worker()
        self.assertEqual(result.returncode, 0)
        capture = json.loads(self.capture.read_text())
        args = capture["args"]
        self.assertEqual(args[args.index("--tools")+1], "Read,Glob,Grep")
        self.assertEqual(capture["brief"], self.brief.read_text())
        self.assertEqual(capture["cwd"], str(self.project))
        self.assertNotIn(capture["brief"], args)
        self.assertEqual(list(self.project.iterdir()), [])
        self.assertEqual(Path(payload["artifacts"]).stat().st_mode & 0o777, 0o700)
        self.assertEqual(Path(payload["report"]).stat().st_mode & 0o777, 0o600)

    def test_api_and_provider_overrides_are_removed_without_altering_parent(self):
        _, payload = self.run_worker(ANTHROPIC_API_KEY="should-never-be-used", ANTHROPIC_AUTH_TOKEN="unused", CLAUDE_CODE_USE_BEDROCK="1", CLAUDE_CODE_SIMPLE="1")
        self.assertEqual(payload["status"], "complete")
        capture = json.loads(self.capture.read_text())
        self.assertNotIn("ANTHROPIC_API_KEY", capture["provider_env"])
        self.assertNotIn("CLAUDE_CODE_USE_BEDROCK", capture["provider_env"])
        self.assertNotIn("CLAUDE_CODE_SIMPLE", capture["provider_env"])
        for path in Path(payload["artifacts"]).iterdir():
            self.assertNotIn("should-never-be-used", path.read_text())

    def test_implementation_preserves_source_and_returns_applicable_patch(self):
        self.create_repo()
        before = self.git("status", "--porcelain=v1", "-z")
        index_before = self.git("diff", "--cached", "--binary")
        working_before = (self.project / "src/app.py").read_bytes()
        result, payload = self.run_worker("--mode", "implement", "--allow-file", "src/app.py", "--allow-file", "new.py", TEST_BEHAVIOR="implement")
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(self.git("status", "--porcelain=v1", "-z"), before)
        self.assertEqual(self.git("diff", "--cached", "--binary"), index_before)
        self.assertEqual((self.project / "src/app.py").read_bytes(), working_before)
        self.assertFalse((self.project / "new.py").exists())
        workspace = Path(payload["artifacts"]) / "workspace"
        self.assertIn("'working tree'", (workspace / "src/app.py").read_text())
        self.assertTrue((workspace / "untracked.py").exists())
        self.assertFalse((workspace / ".env").exists())
        self.assertFalse((workspace / "dependencies").exists())
        self.assertFalse((workspace / "deleted.txt").exists())
        self.assertEqual(set(payload["changed_files"]), {"src/app.py", "new.py"})
        self.git("apply", "--check", payload["patch"])
        self.git("apply", payload["patch"])
        self.assertIn("contribution from Claude", (self.project / "src/app.py").read_text())
        self.assertTrue((self.project / "new.py").exists())
        self.assertEqual(self.git("diff", "--cached", "--binary"), index_before)

    def test_out_of_scope_change_is_failed_and_source_is_unchanged(self):
        self.create_repo()
        result, payload = self.run_worker("--mode", "implement", "--allow-file", "src/app.py", TEST_BEHAVIOR="out_of_scope")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["status"], "scope_violation")
        self.assertFalse((self.project / "unassigned.txt").exists())
        self.assertTrue((Path(payload["artifacts"]) / "changes.patch").exists())

    def test_symlink_is_not_followed_into_source_or_external_files(self):
        self.create_repo()
        secret = self.base / "outside.txt"
        secret.write_text("outside")
        (self.project / "link.txt").symlink_to(secret)
        result, payload = self.run_worker("--mode", "implement", "--allow-file", "src/app.py")
        self.assertEqual(result.returncode, 1)
        self.assertIn("symlink", payload["message"])
        self.assertFalse(self.capture.exists())
        self.assertEqual(secret.read_text(), "outside")

    def test_limits_denials_and_incomplete_results_are_not_success(self):
        for behavior, status in (("limit", "limit_reached"), ("denial", "permission_denied"), ("max_turns", "failed"), ("empty", "failed")):
            with self.subTest(behavior=behavior):
                result, payload = self.run_worker(TEST_BEHAVIOR=behavior)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(payload["status"], status)
                saved = json.loads((Path(payload["artifacts"]) / "result.json").read_text())
                self.assertEqual(saved["status"], status)

    def test_timeout_stops_worker_and_saves_status(self):
        start = time.monotonic()
        result, payload = self.run_worker("--timeout", "1", TEST_BEHAVIOR="timeout")
        self.assertLess(time.monotonic() - start, 6)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["status"], "timed_out")
        self.assertTrue((Path(payload["artifacts"]) / "brief.md").exists())

    def test_assignments_cannot_escape_project(self):
        for name in ("../outside.py", "/absolute.py", ".git/config"):
            result, payload = self.run_worker("--mode", "implement", "--allow-file", name)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(self.capture.exists())

    def test_termination_cancels_child_and_saves_final_state(self):
        child = subprocess.Popen(
            [sys.executable, str(ROOT / "claudex.py"), "run", "--project", str(self.project), "--prompt-file", str(self.brief)],
            env={**self.env, "TEST_BEHAVIOR": "timeout"}, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        try:
            deadline = time.monotonic() + 5
            while not self.capture.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(self.capture.exists())
            worker_pid = json.loads(self.capture.read_text())["pid"]
            child.terminate()
            stdout, stderr = child.communicate(timeout=5)
            result = json.loads(stdout)
            self.assertEqual(result["status"], "cancelled")
            with self.assertRaises(ProcessLookupError):
                os.kill(worker_pid, 0)
            saved = json.loads((Path(result["artifacts"]) / "result.json").read_text())
            self.assertEqual(saved["status"], "cancelled")
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_binary_patch_preserves_bytes(self):
        self.create_repo()
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            work = target / "copy"
            claudex.snapshot(self.project, work)
            (work / "asset.bin").write_bytes(b"\x00\x01\xff\x80\n")
            changed = claudex.collect_patch(work, target, ["asset.bin"])
            self.assertEqual(changed, ["asset.bin"])
            self.git("apply", "--check", str(target / "changes.patch"))
            self.git("apply", str(target / "changes.patch"))
            self.assertEqual((self.project / "asset.bin").read_bytes(), b"\x00\x01\xff\x80\n")

    def test_inherited_git_index_does_not_change_source_index(self):
        self.create_repo()
        index = self.project / ".git/index"
        before = index.read_bytes()
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {"GIT_INDEX_FILE": str(index)}):
                claudex.snapshot(self.project, Path(folder) / "copy")
        self.assertEqual(index.read_bytes(), before)

    def test_snapshot_preserves_bytes_despite_text_attributes_and_filters(self):
        self.create_repo()
        (self.project / ".gitattributes").write_text("asset.txt text eol=lf filter=fixture\n")
        original = b"First line\r\nSecond line\r\n"
        (self.project / "asset.txt").write_bytes(original)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            work = target / "copy"
            claudex.snapshot(self.project, work)
            self.assertEqual(claudex.git(work, "show", "HEAD:asset.txt"), original)
            # A filter that fails if invoked demonstrates that snapshot Git never
            # executes the configured conversion while collecting the patch.
            claudex.git(work, "config", "filter.fixture.clean", "false")
            claudex.git(work, "config", "filter.fixture.required", "true")
            updated = original + b"Third line\r\n"
            (work / "asset.txt").write_bytes(updated)
            claudex.collect_patch(work, target, ["asset.txt"])
            self.git("apply", "--check", str(target / "changes.patch"))
            self.git("apply", str(target / "changes.patch"))
            self.assertEqual((self.project / "asset.txt").read_bytes(), updated)

    def test_utf8_input_and_output_survive_ascii_locale(self):
        self.brief.write_text("Review this: café, α, 🚀.\n", encoding="utf-8")
        result, payload = self.run_worker(TEST_BEHAVIOR="unicode", LC_ALL="C", PYTHONUTF8="0", PYTHONCOERCECLOCALE="0")
        self.assertEqual(result.returncode, 0, payload)
        self.assertIn("α", Path(payload["report"]).read_text(encoding="utf-8"))


class CodexWorkerTests(BridgeCase):
    def run_codex(self, *extra, **env):
        return self.run_worker("--worker", "codex", *extra, **env)

    def test_doctor_checks_login_without_inference(self):
        result, payload = self.invoke("doctor", "--worker", "codex")
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["worker"], "codex")
        self.assertEqual(payload["auth_method"], "chatgpt")
        self.assertIn("config", payload)
        self.assertFalse(self.capture.exists())

    def test_missing_or_api_key_login_never_starts_worker(self):
        for auth in ("missing", "api"):
            with self.subTest(auth=auth):
                result, payload = self.run_codex(TEST_AUTH=auth)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(payload["status"], "needs_auth")
                self.assertFalse(self.capture.exists())

    def test_consult_runs_exec_with_user_config_and_literal_stdin_brief(self):
        result, payload = self.run_codex("--model", "gpt-test")
        self.assertEqual(result.returncode, 0, payload)
        capture = json.loads(self.capture.read_text())
        args = capture["args"]
        self.assertEqual(args[0], "exec")
        self.assertEqual(args[-1], "-")
        self.assertEqual(args[args.index("--cd")+1], str(self.project))
        self.assertEqual(args[args.index("--model")+1], "gpt-test")
        for flag in ("--ephemeral", "--json", "--skip-git-repo-check", "--output-last-message"):
            self.assertIn(flag, args)
        # The user's own Codex configuration applies: no sandbox, approval, feature,
        # MCP, rules, or config-loading overrides are added by the bridge.
        for flag in ("--ignore-user-config", "--ignore-rules", "--sandbox", "--disable", "--enable", "--profile"):
            self.assertNotIn(flag, args)
        overrides = [args[i+1] for i, item in enumerate(args) if item == "-c"]
        self.assertEqual(len(overrides), 2, overrides)
        self.assertTrue(any(item.startswith("skills.config=[{path=") and "skills/claudex/SKILL.md" in item and "enabled=false" in item for item in overrides))
        developer = next(item for item in overrides if item.startswith("developer_instructions="))
        self.assertIn("You are Codex", developer)
        self.assertIn("image_gen", developer)
        self.assertIn("read-only consultation", developer)
        self.assertEqual(capture["brief"], self.brief.read_text())
        self.assertNotIn(capture["brief"], args)
        self.assertEqual(capture["cwd"], str(self.project))
        self.assertEqual(list(self.project.iterdir()), [])
        artifacts = Path(payload["artifacts"])
        self.assertEqual(artifacts.stat().st_mode & 0o777, 0o700)
        self.assertEqual((artifacts / "stdout.jsonl").stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(payload["report"]).read_text(), "Focused handoff based on the supplied context.\n")
        self.assertEqual(payload["worker"], "codex")
        self.assertEqual(payload["thread_id"], "thread_fake")
        self.assertEqual(payload["usage"], {"input_tokens": 25, "cached_input_tokens": 5, "output_tokens": 10})
        self.assertEqual(payload["failed_commands"], 1)
        self.assertEqual(payload["permission_denials"], [])
        self.assertIsNone(payload["max_turns"])
        self.assertTrue(payload["worker_version"].startswith("codex-cli"))

    def test_openai_overrides_are_removed_and_nested_marker_is_set(self):
        codex_home = self.base / "codex-home"
        _, payload = self.run_codex(OPENAI_API_KEY="should-never-be-used", OPENAI_BASE_URL="http://localhost:1", CODEX_API_KEY="unused", CODEX_HOME=str(codex_home))
        self.assertEqual(payload["status"], "complete", payload)
        capture = json.loads(self.capture.read_text())
        self.assertNotIn("OPENAI_API_KEY", capture["provider_env"])
        self.assertNotIn("OPENAI_BASE_URL", capture["provider_env"])
        self.assertNotIn("CODEX_API_KEY", capture["provider_env"])
        self.assertEqual(capture["provider_env"]["CODEX_HOME"], str(codex_home))
        self.assertEqual(capture["provider_env"]["CLAUDEX_WORKER"], "1")
        overrides = [capture["args"][i+1] for i, item in enumerate(capture["args"]) if item == "-c"]
        self.assertTrue(any(str(codex_home / "skills/claudex/SKILL.md") in item for item in overrides))
        for path in Path(payload["artifacts"]).iterdir():
            self.assertNotIn("should-never-be-used", path.read_text())

    def test_claude_worker_also_receives_nested_marker(self):
        _, payload = self.run_worker()
        self.assertEqual(payload["status"], "complete", payload)
        self.assertEqual(json.loads(self.capture.read_text())["provider_env"]["CLAUDEX_WORKER"], "1")

    def test_nested_invocation_is_refused_for_both_workers(self):
        for worker in ("claude", "codex"):
            with self.subTest(worker=worker):
                result, payload = self.run_worker("--worker", worker, CLAUDEX_WORKER="1")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(payload["status"], "failed")
                self.assertIn("Nested collaboration", payload["message"])
                self.assertNotIn("artifacts", payload)
                self.assertFalse(self.capture.exists())

    def test_max_turns_is_rejected_for_codex(self):
        result, payload = self.run_codex("--max-turns", "5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--max-turns", payload["message"])
        self.assertFalse(self.capture.exists())

    def test_implementation_preserves_source_and_returns_applicable_patch(self):
        self.create_repo()
        before = self.git("status", "--porcelain=v1", "-z")
        index_before = self.git("diff", "--cached", "--binary")
        working_before = (self.project / "src/app.py").read_bytes()
        result, payload = self.run_codex("--mode", "implement", "--allow-file", "src/app.py", "--allow-file", "new.py", TEST_BEHAVIOR="implement")
        self.assertEqual(result.returncode, 0, payload)
        capture = json.loads(self.capture.read_text())
        workspace = Path(payload["artifacts"]) / "workspace"
        self.assertNotIn("--sandbox", capture["args"])
        self.assertEqual(capture["args"][capture["args"].index("--cd")+1], str(workspace))
        self.assertNotIn("--skip-git-repo-check", capture["args"])
        self.assertEqual(capture["cwd"], str(workspace))
        developer = next(capture["args"][i+1] for i, item in enumerate(capture["args"]) if item == "-c" and capture["args"][i+1].startswith("developer_instructions="))
        self.assertIn("generated image", developer)
        self.assertEqual(self.git("status", "--porcelain=v1", "-z"), before)
        self.assertEqual(self.git("diff", "--cached", "--binary"), index_before)
        self.assertEqual((self.project / "src/app.py").read_bytes(), working_before)
        self.assertFalse((self.project / "new.py").exists())
        self.assertIn("'working tree'", (workspace / "src/app.py").read_text())
        self.assertTrue((workspace / "untracked.py").exists())
        self.assertFalse((workspace / ".env").exists())
        self.assertFalse((workspace / "dependencies").exists())
        self.assertFalse((workspace / "deleted.txt").exists())
        self.assertEqual(set(payload["changed_files"]), {"src/app.py", "new.py"})
        self.git("apply", "--check", payload["patch"])
        self.git("apply", payload["patch"])
        self.assertIn("contribution from Codex", (self.project / "src/app.py").read_text())
        self.assertTrue((self.project / "new.py").exists())
        self.assertEqual(self.git("diff", "--cached", "--binary"), index_before)

    def test_out_of_scope_change_is_failed_and_source_is_unchanged(self):
        self.create_repo()
        result, payload = self.run_codex("--mode", "implement", "--allow-file", "src/app.py", TEST_BEHAVIOR="out_of_scope")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["status"], "scope_violation")
        self.assertFalse((self.project / "unassigned.txt").exists())
        self.assertTrue((Path(payload["artifacts"]) / "changes.patch").exists())

    def test_limits_denials_and_incomplete_results_are_not_success(self):
        for behavior, status in (("limit", "limit_reached"), ("denial", "permission_denied"), ("empty", "failed")):
            with self.subTest(behavior=behavior):
                result, payload = self.run_codex(TEST_BEHAVIOR=behavior)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(payload["status"], status)
                saved = json.loads((Path(payload["artifacts"]) / "result.json").read_text())
                self.assertEqual(saved["status"], status)
                if behavior == "denial":
                    self.assertEqual(saved["permission_denials"], [{"command": "curl example.com", "status": "declined"}])

    def test_read_only_runs_report_source_changes_as_a_warning(self):
        self.create_repo()
        (self.project / ".gitignore").write_text(".env\ndependencies/\n__pycache__/\n")
        result, payload = self.run_codex("--mode", "review")
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["source_changes"], [])
        self.assertNotIn("warning", payload)
        result, payload = self.run_codex("--mode", "review", TEST_BEHAVIOR="edit_source")
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["source_changes"], ["src/app.py", "tampered.txt", "untracked.py"])
        self.assertIn("3 project file(s) changed", payload["warning"])
        self.assertIn("Claudex: warning:", result.stderr)
        saved = json.loads((Path(payload["artifacts"]) / "result.json").read_text())
        self.assertEqual(saved["source_changes"], payload["source_changes"])
        plain = self.base / "plain-folder"
        plain.mkdir()
        _, payload = self.invoke("run", "--worker", "codex", "--project", str(plain), "--prompt-file", str(self.brief))
        self.assertEqual(payload["status"], "complete", payload)
        self.assertIsNone(payload["source_changes"], "detection is unavailable outside Git")

    def test_timeout_stops_worker_and_saves_status(self):
        start = time.monotonic()
        result, payload = self.run_codex("--timeout", "1", TEST_BEHAVIOR="timeout")
        self.assertLess(time.monotonic() - start, 6)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["status"], "timed_out")
        worker_pid = json.loads(self.capture.read_text())["pid"]
        with self.assertRaises(ProcessLookupError):
            os.kill(worker_pid, 0)

    def test_utf8_input_and_output_survive_ascii_locale(self):
        self.brief.write_text("Review this: café, α, 🚀.\n", encoding="utf-8")
        result, payload = self.run_codex(TEST_BEHAVIOR="unicode", LC_ALL="C", PYTHONUTF8="0", PYTHONCOERCECLOCALE="0")
        self.assertEqual(result.returncode, 0, payload)
        self.assertIn("α", Path(payload["report"]).read_text(encoding="utf-8"))
        self.assertEqual(json.loads(self.capture.read_text())["brief"], self.brief.read_text(encoding="utf-8"))

    def test_toml_string_round_trips_prompt_text(self):
        import tomllib
        text = 'Line one\nQuote " and backslash \\ and unicode é 🚀\ttab'
        self.assertEqual(tomllib.loads("value = " + claudex.toml_string(text))["value"], text)


class InstallerTests(unittest.TestCase):
    def test_install_is_idempotent_and_uninstall_preserves_other_instructions(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            codex = user / ".codex"
            codex.mkdir()
            agents = codex / "AGENTS.md"
            original = "Existing user instructions, without a trailing newline."
            agents.write_text(original)
            first = install.install(user_home=user, codex_dir=codex)
            self.assertEqual(Path(first["codex"]["backup"]).read_text(), original)
            after = agents.read_text()
            second = install.install(user_home=user, codex_dir=codex)
            self.assertEqual(agents.read_text(), after)
            self.assertIsNone(second["codex"]["backup"])
            self.assertTrue((codex / "skills/claudex").is_symlink())
            agents.write_text(after + "\nUser added a new instruction.\n")
            install.install(user_home=user, codex_dir=codex, uninstall=True)
            self.assertEqual(agents.read_text(), original + "\nUser added a new instruction.\n")
            self.assertFalse((user / ".local/bin/claudex").exists())

    def test_unrelated_files_are_preserved_without_partial_install(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            codex = user / ".codex"
            command = user / ".local/bin/claudex"
            command.parent.mkdir(parents=True)
            command.write_text("unrelated tool")
            with self.assertRaises(ValueError):
                install.install(user_home=user, codex_dir=codex)
            self.assertFalse((codex / "AGENTS.md").exists())
            self.assertEqual(command.read_text(), "unrelated tool")

    def test_claude_lead_installs_skill_and_policy_and_uninstall_restores(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            claude = user / ".claude"
            claude.mkdir()
            memory = claude / "CLAUDE.md"
            original = "# My global rules\n\nAlways run tests.\n"
            memory.write_text(original)
            result = install.install(user_home=user, claude_dir=claude, leads=("claude",))
            self.assertEqual(result["leads"], ["claude"])
            self.assertNotIn("codex", result)
            self.assertEqual(Path(result["claude"]["backup"]).read_text(), original)
            text = memory.read_text()
            self.assertTrue(text.endswith(original))
            self.assertIn("Claude Code to lead", text)
            self.assertIn("installed Codex CLI", text)
            self.assertIn(str(claude / "skills/claudex/SKILL.md"), text)
            skill = claude / "skills/claudex"
            self.assertTrue(skill.is_symlink())
            self.assertEqual(skill.resolve(), ROOT / "skills/claude-lead/claudex")
            self.assertTrue((skill / "SKILL.md").read_text().startswith("---\nname: claudex\n"))
            self.assertFalse((user / ".codex").exists())
            self.assertTrue((user / ".local/bin/claudex").is_symlink())
            install.install(user_home=user, claude_dir=claude, leads=("claude",), uninstall=True)
            self.assertEqual(memory.read_text(), original)
            self.assertFalse(skill.exists())
            self.assertFalse((user / ".local/bin/claudex").exists())

    def test_both_leads_share_one_command_and_single_uninstall_keeps_it(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            codex, claude = user / ".codex", user / ".claude"
            result = install.install(user_home=user, codex_dir=codex, claude_dir=claude)
            self.assertEqual(result["leads"], ["codex", "claude"])
            self.assertIn("Codex to lead", (codex / "AGENTS.md").read_text())
            self.assertIn("Claude Code to lead", (claude / "CLAUDE.md").read_text())
            self.assertEqual((codex / "skills/claudex").resolve(), ROOT / "skills/codex-lead/claudex")
            self.assertEqual((claude / "skills/claudex").resolve(), ROOT / "skills/claude-lead/claudex")
            command = user / ".local/bin/claudex"
            install.install(user_home=user, codex_dir=codex, claude_dir=claude, leads=("codex",), uninstall=True)
            self.assertEqual((codex / "AGENTS.md").read_text(), "")
            self.assertFalse((codex / "skills/claudex").exists())
            self.assertTrue((claude / "skills/claudex").is_symlink())
            self.assertTrue(command.is_symlink())
            install.install(user_home=user, codex_dir=codex, claude_dir=claude, leads=("claude",), uninstall=True)
            self.assertFalse(command.exists())

    def test_problem_on_either_side_changes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            codex, claude = user / ".codex", user / ".claude"
            unrelated = claude / "skills/claudex"
            unrelated.mkdir(parents=True)
            (unrelated / "SKILL.md").write_text("someone else's skill")
            with self.assertRaises(ValueError):
                install.install(user_home=user, codex_dir=codex, claude_dir=claude)
            self.assertFalse((codex / "AGENTS.md").exists())
            self.assertFalse((claude / "CLAUDE.md").exists())
            self.assertFalse((user / ".local/bin/claudex").exists())
            self.assertEqual((unrelated / "SKILL.md").read_text(), "someone else's skill")
            (unrelated / "SKILL.md").unlink()
            unrelated.rmdir()
            claude.mkdir(exist_ok=True)
            (claude / "CLAUDE.md").write_text(install.START + "\n" + install.START + "\n" + install.END + "\n")
            with self.assertRaises(ValueError):
                install.install(user_home=user, codex_dir=codex, claude_dir=claude)
            self.assertFalse((codex / "AGENTS.md").exists())
            self.assertFalse((codex / "skills/claudex").exists())

    def test_link_from_previous_layout_is_migrated(self):
        with tempfile.TemporaryDirectory() as folder:
            user = Path(folder)
            codex = user / ".codex"
            stale = codex / "skills/claudex"
            stale.parent.mkdir(parents=True)
            stale.symlink_to(ROOT / "skills/claudex")  # 0.1.0 location, now dangling
            self.assertFalse(stale.exists())
            install.install(user_home=user, codex_dir=codex, leads=("codex",))
            self.assertEqual(stale.resolve(), ROOT / "skills/codex-lead/claudex")
            foreign = user / "elsewhere/claudex"
            foreign.parent.mkdir()
            foreign.mkdir()
            (codex / "skills/claudex").unlink()
            (codex / "skills/claudex").symlink_to(foreign)
            with self.assertRaises(ValueError):
                install.install(user_home=user, codex_dir=codex, leads=("codex",))


if __name__ == "__main__":
    unittest.main()
