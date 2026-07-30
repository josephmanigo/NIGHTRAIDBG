from __future__ import annotations

import unittest

from modules.scoreboard.contracts import FieldReading, ScoreboardRow
from modules.scoreboard.discord_handler import format_game_result
from modules.scoreboard.google_sheets import build_sheet_write_intents
from modules.scoreboard.team_manager import TeamRegistry


def accepted_row() -> ScoreboardRow:
    return ScoreboardRow(
        row_index=0,
        placement=FieldReading(1, 0.99),
        slot=FieldReading("O", 0.99),
        kills=FieldReading(65, 0.99),
        team_name="LGT - AKATSOKE",
        placement_points=20,
        kill_points=65,
        total_score=85,
    )


class TeamAndOutputTests(unittest.TestCase):
    def test_registered_slot_resolves_team(self) -> None:
        registry = TeamRegistry(
            {
                "A": "APXS - APEX SYNDICATE",
                "O": "LGT - AKATSOKE",
            }
        )
        self.assertEqual(registry.resolve("0"), "LGT - AKATSOKE")
        self.assertIsNone(registry.resolve("Y"))

    def test_invalid_or_duplicate_slots_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            TeamRegistry({"Z": "OUT OF RANGE"})
        with self.assertRaises(ValueError):
            TeamRegistry({"O": "ONE", "0": "TWO"})

    def test_sheet_adapter_builds_intent_without_network_write(self) -> None:
        intents = build_sheet_write_intents(1, [accepted_row()])
        self.assertEqual(
            intents[0].as_dict(),
            {
                "game_number": 1,
                "team_slot": "O",
                "team_name": "LGT - AKATSOKE",
                "placement": 1,
                "placement_points": 20,
                "kills": 65,
                "kill_points": 65,
                "total_score": 85,
            },
        )

    def test_review_rows_are_not_eligible_for_sheet_intent(self) -> None:
        row = accepted_row()
        review_row = ScoreboardRow(
            **{
                **row.__dict__,
                "warnings": ("slot_not_registered",),
            }
        )
        self.assertEqual(build_sheet_write_intents(1, [review_row]), [])

    def test_discord_output_is_plain_markdown(self) -> None:
        output = format_game_result(1, [accepted_row()])
        self.assertIn("# 🔥 NIGHTRAID GAME 1 RESULT", output)
        self.assertIn("LGT - AKATSOKE", output)
        self.assertIn("Slot: **O**", output)
        self.assertIn("TOTAL SCORE: **85 POINTS**", output)
        self.assertIn("Google Sheet Updated ✅", output)
        self.assertNotIn("embed", output.lower())


if __name__ == "__main__":
    unittest.main()
