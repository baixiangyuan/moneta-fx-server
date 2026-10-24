"""通过 GitHub API 推送本地 git 仓库（git 直连被网络阻断时的替代方案）。

流程：
  1. 用 `git ls-tree -r` 读本地最新 commit 的文件清单与 blob sha
  2. 逐个上传 blob（base64），收集 path/mode/sha
  3. 一次性创建 tree
  4. 创建 commit（带上一次推送的 commit 作为 parent）
  5. 更新分支 ref

用法：
    python scripts/push_via_api.py <owner/repo> <branch>
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

API = "https://api.github.com"
STATE_FILE = ".api-push-parent"


def gh(args: list[str], payload: dict | None = None) -> dict:
    cmd = ["gh", "api", *args]
    if payload is not None:
        cmd += ["--input", "-"]
    result = subprocess.run(
        cmd,
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", cwd=str(cwd))
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)

    repo, branch = sys.argv[1], sys.argv[2]
    root = Path.cwd()

    ensure_repo_initialized(repo, branch)

    head = git(["rev-parse", "HEAD"], root).strip()
    message = git(["log", "-1", "--format=%B"], root).strip()

    # 本地 tree 条目：<mode> <type> <sha>\t<path>
    entries: list[dict] = []
    for line in git(["ls-tree", "-r", head], root).splitlines():
        meta, _, path = line.partition("\t")
        mode, obj_type, sha = meta.split()
        if obj_type != "blob":
            continue
        data = (root / path).read_bytes()
        blob = gh(
            ["-X", "POST", f"repos/{repo}/git/blobs"],
            {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"},
        )
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        print(f"  blob {path}")

    tree = gh(["-X", "POST", f"repos/{repo}/git/trees"], {"tree": entries})
    print(f"tree {tree['sha'][:8]}")

    parent_file = root / STATE_FILE
    parents: list[str] = []
    if parent_file.is_file():
        saved = parent_file.read_text(encoding="utf-8").strip()
        if saved:
            parents.append(saved)
            print(f"parent {saved[:8]}")

    commit = gh(
        ["-X", "POST", f"repos/{repo}/git/commits"],
        {"message": message, "tree": tree["sha"], "parents": parents},
    )
    print(f"commit {commit['sha'][:8]}")

    ref = gh(["-X", "PATCH", f"repos/{repo}/git/refs/heads/{branch}"], {"sha": commit["sha"], "force": True})
    parent_file.write_text(commit["sha"], encoding="utf-8")
    print(f"pushed {repo} {branch} -> {ref['object']['sha'][:8]}")


def ensure_repo_initialized(repo: str, branch: str) -> None:
    """空仓库连创建 tree 都会被拒（HTTP 409），先用 contents 接口落一个 README。"""
    try:
        gh([f"repos/{repo}/git/refs/heads/{branch}"])
        return
    except subprocess.CalledProcessError:
        pass

    content = base64.b64encode(f"# {repo.split('/')[-1]}\n".encode()).decode("ascii")
    result = gh(["-X", "PUT", f"repos/{repo}/contents/README.md"], {"message": "Initial commit", "content": content})
    print(f"initialized empty repo {repo} with ref {branch} -> {result['commit']['sha'][:8]}")


if __name__ == "__main__":
    main()
