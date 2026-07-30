from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from modules.scoreboard.image_processor import (
    crop_scoreboard_fields,
    load_layout,
    validate_layout,
)


def test_layout() -> dict[str, object]:
    return {
        "id": "test-layout",
        "version": 1,
        "coordinate_space": 1000,
        "reference_size": {"width": 300, "height": 200},
        "aspect_ratio_tolerance": 0.01,
        "leaderboard_region": [0, 0, 1000, 1000],
        "rows": [
            [0, 0, 1000, 500],
            [0, 500, 1000, 500],
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


class ImageLayoutTests(unittest.TestCase):
    def test_layout_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "layout.json")
            path.write_text(json.dumps(test_layout()), encoding="utf-8")
            self.assertEqual(load_layout(path)["id"], "test-layout")

    def test_invalid_rect_is_rejected(self) -> None:
        layout = test_layout()
        layout["leaderboard_region"] = [900, 0, 200, 1000]
        with self.assertRaises(ValueError):
            validate_layout(layout)

    def test_fixed_coordinates_produce_expected_field_crops(self) -> None:
        layout = validate_layout(test_layout())
        image = np.zeros((200, 300, 3), dtype=np.uint8)
        expected = {
            (0, "placement"): 20,
            (0, "slot"): 40,
            (0, "kills"): 60,
            (1, "placement"): 80,
            (1, "slot"): 100,
            (1, "kills"): 120,
        }
        for row_index, y_range in enumerate((slice(0, 100), slice(100, 200))):
            image[y_range, 0:100] = expected[(row_index, "placement")]
            image[y_range, 100:200] = expected[(row_index, "slot")]
            image[y_range, 200:300] = expected[(row_index, "kills")]
        crops = crop_scoreboard_fields(image, layout)
        self.assertEqual(len(crops), 6)
        for crop in crops:
            self.assertAlmostEqual(
                float(crop.pixels.mean()),
                expected[(crop.row_index, crop.field)],
                delta=1.0,
            )


if __name__ == "__main__":
    unittest.main()
