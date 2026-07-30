"""Builds safe write intents; this module performs no Google API requests."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable

from .contracts import ScoreboardRow


@dataclass(frozen=True)
class SheetWriteIntent:
    game_number: int
    team_slot: str
    team_name: str
    placement: int
    placement_points: int
    kills: int
    kill_points: int
    total_score: int

    def as_dict(self) -> dict[str, int | str]:
        return asdict(self)


def build_sheet_write_intents(
    game_number: int,
    rows: Iterable[ScoreboardRow],
) -> list[SheetWriteIntent]:
    """Convert verified rows to data for the existing guarded Node writer."""

    if isinstance(game_number, bool) or game_number not in {1, 2, 3, 4}:
        raise ValueError("game_number must be 1, 2, 3, or 4")
    intents: list[SheetWriteIntent] = []
    for row in rows:
        if row.review_required:
            continue
        if not isinstance(row.placement.value, int):
            continue
        if not isinstance(row.slot.value, str):
            continue
        if not isinstance(row.kills.value, int):
            continue
        if row.team_name is None:
            continue
        if None in (row.placement_points, row.kill_points, row.total_score):
            continue
        intents.append(
            SheetWriteIntent(
                game_number=game_number,
                team_slot=row.slot.value,
                team_name=row.team_name,
                placement=row.placement.value,
                placement_points=row.placement_points,
                kills=row.kills.value,
                kill_points=row.kill_points,
                total_score=row.total_score,
            )
        )
    return intents
