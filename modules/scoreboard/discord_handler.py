"""Plain Discord Markdown formatting without a second Discord connection."""

from __future__ import annotations

from collections.abc import Iterable

from .contracts import ScoreboardRow


def format_game_result(game_number: int, rows: Iterable[ScoreboardRow]) -> str:
    if game_number not in {1, 2, 3, 4}:
        raise ValueError("game_number must be 1, 2, 3, or 4")
    lines = [f"# 🔥 NIGHTRAID GAME {game_number} RESULT", ""]
    accepted = [row for row in rows if not row.review_required]
    for row in accepted:
        lines.extend(
            [
                f"## {row.team_name or row.slot.value or 'UNKNOWN TEAM'}",
                f"Slot: **{row.slot.value}**",
                f"Placement: **#{row.placement.value}**",
                f"Kills: **{row.kills.value}**",
                f"Placement Points: **{row.placement_points}**",
                f"Kill Points: **{row.kill_points}**",
                f"TOTAL SCORE: **{row.total_score} POINTS**",
                "",
            ]
        )
    if not accepted:
        lines.append("Unable to read the screenshot confidently. Please verify manually.")
    else:
        lines.append("Google Sheet Updated ✅")
    return "\n".join(lines).strip()
