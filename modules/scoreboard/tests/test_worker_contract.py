from __future__ import annotations

import inspect
import unittest

from modules.scoreboard import worker
from modules.scoreboard import google_sheets


class WorkerContractTests(unittest.TestCase):
    def test_diagnostic_contract_declares_no_paid_ai(self) -> None:
        report = worker.dependency_report()
        self.assertFalse(report["paid_ai_used"])
        self.assertIn("opencv", report)
        self.assertIn("tesseract", report)

    def test_python_sheet_adapter_has_no_network_client(self) -> None:
        source = inspect.getsource(google_sheets).lower()
        for forbidden in (
            "import requests",
            "from requests",
            "import urllib",
            "from urllib",
            "googleapiclient",
            "httpx",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)

    def test_scoreboard_package_has_no_paid_vision_import(self) -> None:
        modules = (
            "ocr_processor.py",
            "image_processor.py",
            "worker.py",
        )
        package_root = inspect.getfile(worker)
        package_root = package_root.rsplit("\\", 1)[0]
        for filename in modules:
            with open(f"{package_root}\\{filename}", encoding="utf-8") as handle:
                source = handle.read().lower()
            with self.subTest(filename=filename):
                self.assertNotIn("openai", source)
                self.assertNotIn("gemini", source)
                self.assertNotIn("google vision", source)


if __name__ == "__main__":
    unittest.main()
