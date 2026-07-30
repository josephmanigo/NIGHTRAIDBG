"""Serializable contracts shared by the local scoreboard worker."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class FieldReading:
    """One OCR field and the evidence used to accept or review it."""

    value: int | str | None
    confidence: float
    raw_text: str = ""
    source: str = "ocr"
    corrections: tuple[str, ...] = ()
    review_required: bool = False
    bbox: tuple[int, int, int, int] | None = None

    def as_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["corrections"] = list(self.corrections)
        result["bbox"] = list(self.bbox) if self.bbox else None
        return result


@dataclass(frozen=True)
class ScoreboardRow:
    """A placement, slot letter, and displayed team kills from one row."""

    row_index: int
    placement: FieldReading
    slot: FieldReading
    kills: FieldReading
    team_name: str | None = None
    placement_points: int | None = None
    kill_points: int | None = None
    total_score: int | None = None
    warnings: tuple[str, ...] = ()

    @property
    def review_required(self) -> bool:
        return bool(
            self.warnings
            or self.placement.review_required
            or self.slot.review_required
            or self.kills.review_required
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "row_index": self.row_index,
            "placement": self.placement.value,
            "slot": self.slot.value,
            "kills": self.kills.value,
            "team_name": self.team_name,
            "placement_points": self.placement_points,
            "kill_points": self.kill_points,
            "total_score": self.total_score,
            "confidence": {
                "placement": self.placement.confidence,
                "slot": self.slot.confidence,
                "kills": self.kills.confidence,
            },
            "evidence": {
                "placement": self.placement.as_dict(),
                "slot": self.slot.as_dict(),
                "kills": self.kills.as_dict(),
            },
            "review_required": self.review_required,
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class ScoreboardResult:
    """Complete local processing result for one screenshot."""

    source_path: str
    source_sha256: str
    layout_id: str
    layout_version: int
    image_width: int
    image_height: int
    rows: tuple[ScoreboardRow, ...]
    warnings: tuple[str, ...] = field(default_factory=tuple)
    processing_ms: int = 0

    @property
    def review_required(self) -> bool:
        return bool(self.warnings or any(row.review_required for row in self.rows))

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "nightraid.local-scoreboard.v1",
            "source": {
                "path": self.source_path,
                "sha256": self.source_sha256,
                "width": self.image_width,
                "height": self.image_height,
                "original_preserved": True,
            },
            "layout": {
                "id": self.layout_id,
                "version": self.layout_version,
            },
            "reader": {
                "image_processing": "opencv",
                "ocr": "tesseract",
                "paid_ai_used": False,
                "processing_ms": self.processing_ms,
            },
            "rows": [row.as_dict() for row in self.rows],
            "review_required": self.review_required,
            "warnings": list(self.warnings),
        }
