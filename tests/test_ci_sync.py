from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ci_sync


def run_info(run_id: int, sha: str) -> ci_sync.RunInfo:
    return ci_sync.RunInfo(
        run_id=run_id,
        branch="codex/test",
        head_sha=sha,
        url=f"https://github.example/actions/runs/{run_id}",
        updated_at="2026-08-29T00:00:00Z",
    )


def write_artifact(destination: Path) -> Path:
    destination.mkdir(parents=True)
    package = destination / f"{ci_sync.DEFAULT_ARTIFACT}.zip"
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr("Path of Building.exe", b"test")
        archive.writestr("aipob-package.json", "{}")
    return package


class CiSyncTests(unittest.TestCase):
    def arguments(self, destination: Path) -> argparse.Namespace:
        return argparse.Namespace(
            gh=None,
            git=None,
            branch=None,
            workflow=ci_sync.DEFAULT_WORKFLOW,
            artifact=ci_sync.DEFAULT_ARTIFACT,
            destination=str(destination),
            force=False,
        )

    def test_latest_successful_run_requires_matching_completed_branch(self) -> None:
        response = json.dumps([{
            "databaseId": 42,
            "headBranch": "codex/test",
            "headSha": "abc123",
            "status": "completed",
            "conclusion": "success",
            "url": "https://github.example/actions/runs/42",
            "updatedAt": "2026-08-29T00:00:00Z",
        }])
        with patch.object(ci_sync, "run_capture", return_value=response):
            result = ci_sync.latest_successful_run("gh", "aipob.yml", "codex/test")
        self.assertEqual(result.run_id, 42)
        self.assertEqual(result.head_sha, "abc123")

    def test_windows_gh_receives_a_windows_output_path(self) -> None:
        with patch.object(ci_sync, "find_command", return_value="/usr/bin/wslpath"), patch.object(
            ci_sync,
            "run_capture",
            return_value=r"D:\Projects\AIPoB\artifacts\ci-latest",
        ) as capture:
            value = ci_sync.command_path_argument(
                "/mnt/c/Program Files/GitHub CLI/gh.exe",
                Path("/mnt/d/Projects/AIPoB/artifacts/ci-latest"),
            )
        self.assertEqual(value, r"D:\Projects\AIPoB\artifacts\ci-latest")
        capture.assert_called_once()

    def test_sync_replaces_previous_run_and_keeps_only_latest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "ci-latest"
            current = [run_info(41, "a" * 40)]

            def fake_download(_gh: str, _run: ci_sync.RunInfo, _artifact: str, output: Path) -> Path:
                return write_artifact(output)

            with (
                patch.object(ci_sync, "find_command", side_effect=lambda _explicit, *names: names[0]),
                patch.object(ci_sync, "resolve_branch", return_value="codex/test"),
                patch.object(ci_sync, "latest_successful_run", side_effect=lambda *_args: current[0]),
                patch.object(ci_sync, "download_artifact", side_effect=fake_download),
                patch.object(ci_sync, "verify_package_root"),
            ):
                ci_sync.sync_ci_windows(self.arguments(destination))
                first = ci_sync.read_marker(destination)
                self.assertEqual(first["runId"], 41)

                current[0] = run_info(42, "b" * 40)
                ci_sync.sync_ci_windows(self.arguments(destination))

            marker = ci_sync.read_marker(destination)
            self.assertEqual(marker["runId"], 42)
            self.assertFalse((Path(temporary) / "ci-pending").exists())
            self.assertFalse((Path(temporary) / "ci-latest-old").exists())
            self.assertEqual(len(list(Path(temporary).glob("ci-*"))), 1)

    def test_current_run_does_not_download_again(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "ci-latest"
            info = run_info(42, "b" * 40)

            def fake_download(_gh: str, _run: ci_sync.RunInfo, _artifact: str, output: Path) -> Path:
                return write_artifact(output)

            with (
                patch.object(ci_sync, "find_command", side_effect=lambda _explicit, *names: names[0]),
                patch.object(ci_sync, "resolve_branch", return_value="codex/test"),
                patch.object(ci_sync, "latest_successful_run", return_value=info),
                patch.object(ci_sync, "download_artifact", side_effect=fake_download) as download,
                patch.object(ci_sync, "verify_package_root"),
            ):
                ci_sync.sync_ci_windows(self.arguments(destination))
                ci_sync.sync_ci_windows(self.arguments(destination))

            self.assertEqual(download.call_count, 1)


if __name__ == "__main__":
    unittest.main()
