"""Command-line entry point for the local NIGHTRAID scoreboard reader."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .image_processor import ImageDependencyError
from .ocr_processor import (
    LocalScoreboardReader,
    TesseractDependencyError,
)
from .team_manager import TeamRegistry

DEFAULT_LAYOUT = Path(__file__).with_name("layout.json")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read fixed NIGHTRAID scoreboard screenshots locally."
    )
    parser.add_argument("--image", help="PNG, JPG, JPEG, or WEBP screenshot")
    parser.add_argument("--layout", default=str(DEFAULT_LAYOUT))
    parser.add_argument("--teams-json", help="Optional A-Y registered-team mapping")
    parser.add_argument(
        "--tesseract-cmd",
        default=os.environ.get("TESSERACT_CMD"),
        help="Optional native Tesseract executable path",
    )
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Report local dependencies without reading an image",
    )
    return parser


def dependency_report(tesseract_cmd: str | None = None) -> dict[str, object]:
    report: dict[str, object] = {
        "python": sys.version.split()[0],
        "paid_ai_used": False,
    }
    try:
        import cv2

        report["opencv"] = cv2.__version__
    except ImportError:
        report["opencv"] = None
    try:
        import pytesseract

        report["pytesseract"] = pytesseract.__version__
        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        try:
            report["tesseract"] = str(pytesseract.get_tesseract_version())
        except Exception:
            report["tesseract"] = None
    except ImportError:
        report["pytesseract"] = None
        report["tesseract"] = None
    report["ready"] = bool(
        report.get("opencv")
        and report.get("pytesseract")
        and report.get("tesseract")
    )
    return report


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    indent = 2 if args.pretty else None
    if args.diagnose:
        print(
            json.dumps(
                dependency_report(args.tesseract_cmd),
                indent=indent,
                sort_keys=True,
            )
        )
        return 0
    if not args.image:
        print(
            json.dumps(
                {
                    "schema_version": "nightraid.local-scoreboard.error.v1",
                    "error": "--image is required unless --diagnose is used",
                },
                indent=indent,
            )
        )
        return 2

    try:
        registry = (
            TeamRegistry.from_json_file(args.teams_json)
            if args.teams_json
            else None
        )
        result = LocalScoreboardReader(
            layout_path=args.layout,
            team_registry=registry,
            tesseract_cmd=args.tesseract_cmd,
        ).read(args.image)
        print(json.dumps(result.as_dict(), indent=indent, ensure_ascii=False))
        return 0
    except (
        ImageDependencyError,
        TesseractDependencyError,
        FileNotFoundError,
        ValueError,
    ) as reason:
        print(
            json.dumps(
                {
                    "schema_version": "nightraid.local-scoreboard.error.v1",
                    "error": str(reason),
                },
                indent=indent,
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
