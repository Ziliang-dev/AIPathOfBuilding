import pathlib
import unittest

import update_manifest


class DirectoryFilterTests(unittest.TestCase):
    def test_root_files_are_not_directories(self) -> None:
        excluded = {"artifacts", "sidecar"}

        self.assertFalse(
            update_manifest._exclude_directory(excluded, pathlib.Path("help.txt"))
        )

    def test_matching_directory_prefix_is_excluded(self) -> None:
        excluded = {"artifacts", "sidecar"}

        self.assertTrue(
            update_manifest._exclude_directory(
                excluded,
                pathlib.Path("artifacts/ci-latest/app/help.txt"),
            )
        )

    def test_unrelated_directory_is_not_excluded(self) -> None:
        excluded = {"artifacts", "sidecar"}

        self.assertFalse(
            update_manifest._exclude_directory(
                excluded,
                pathlib.Path("docs/help.txt"),
            )
        )


if __name__ == "__main__":
    unittest.main()
