from __future__ import annotations

import json
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest.mock import patch

import numpy as np

from modules.scoreboard.image_processor import FieldCrop, LoadedImage
from modules.scoreboard.ocr_processor import LocalScoreboardReader, OcrAttempt
from modules.scoreboard.team_manager import TeamRegistry


def pipeline_layout() -> dict[str, object]:
    return {
        "id": "pipeline-test",
        "version": 1,
        "coordinate_space": 1000,
        "reference_size": {"width": 300, "height": 300},
        "aspect_ratio_tolerance": 0.01,
        "leaderboard_region": [0, 0, 1000, 1000],
        "rows": [
            [0, 0, 1000, 333],
            [0, 333, 1000, 334],
            [0, 667, 1000, 333],
        ],
        "columns": {
            "placement": [0, 0, 333, 1000],
            "slot": [333, 0, 334, 1000],
            "kills": [667, 0, 333, 1000],
        },
        "ocr": {
            "upscale": 2,
            "minimum_confidence": 0.82,
            "sequence_anchor_confidence": 0.7,
            "max_placement": 25,
            "max_kills": 999,
        },
    }


class FakeEngine:
    def __init__(self) -> None:
        self.values = {
            "placement": ["", "2", "3"],
            "slot": ["0", "M", "R"],
            "kills": ["G5", "7", "31"],
        }
        self.calls: dict[str, int] = defaultdict(int)

    def recognize(self, _image: np.ndarray, field: str, variant: str) -> OcrAttempt:
        index = self.calls[field]
        self.calls[field] += 1
        return OcrAttempt(self.values[field][index], 0.97, variant)


class ReaderPipelineTests(unittest.TestCase):
    def test_reader_extracts_known_rows_and_infers_medal_placement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout_path = Path(directory, "layout.json")
            layout_path.write_text(json.dumps(pipeline_layout()), encoding="utf-8")
            fake_image = np.zeros((300, 300, 3), dtype=np.uint8)
            loaded = LoadedImage(
                path=Path(directory, "round1.png"),
                original_bytes=b"round1",
                original_sha256="a" * 64,
                pixels=fake_image,
            )
            crops = [
                FieldCrop(
                    row_index=row_index,
                    field=field,
                    bbox=(0, 0, 10, 10),
                    pixels=np.zeros((10, 10, 3), dtype=np.uint8),
                )
                for row_index in range(3)
                for field in ("placement", "slot", "kills")
            ]
            reader = LocalScoreboardReader(
                layout_path=layout_path,
                engine=FakeEngine(),
                team_registry=TeamRegistry(
                    {
                        "O": "LGT - AKATSOKE",
                        "M": "TEAM M",
                        "R": "TEAM R",
                    }
                ),
            )
            with (
                patch(
                    "modules.scoreboard.ocr_processor.load_image",
                    return_value=loaded,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.normalize_image",
                    return_value=fake_image,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.crop_scoreboard_fields",
                    return_value=crops,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.preprocessing_variants",
                    side_effect=lambda pixels, upscale, field=None: {"test": pixels},
                ),
            ):
                result = reader.read(loaded.path)

        self.assertEqual(len(result.rows), 3)
        first = result.rows[0]
        self.assertEqual(first.placement.value, 1)
        self.assertEqual(first.placement.source, "sequence_inferred")
        self.assertEqual(first.slot.value, "O")
        self.assertEqual(first.kills.value, 65)
        self.assertEqual(first.team_name, "LGT - AKATSOKE")
        self.assertEqual(first.total_score, 85)
        self.assertFalse(first.review_required)
        self.assertFalse(result.as_dict()["reader"]["paid_ai_used"])


if __name__ == "__main__":
    unittest.main()
