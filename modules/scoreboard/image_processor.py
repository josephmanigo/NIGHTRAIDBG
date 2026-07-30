"""Fixed-coordinate OpenCV preprocessing for NIGHTRAID screenshots."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover - exercised by dependency diagnostics
    cv2 = None


class ImageDependencyError(RuntimeError):
    """Raised when OpenCV is unavailable in the local worker runtime."""


@dataclass(frozen=True)
class LoadedImage:
    path: Path
    original_bytes: bytes
    original_sha256: str
    pixels: np.ndarray


@dataclass(frozen=True)
class FieldCrop:
    row_index: int
    field: str
    bbox: tuple[int, int, int, int]
    pixels: np.ndarray


def require_opencv() -> Any:
    if cv2 is None:
        raise ImageDependencyError(
            "OpenCV is required. Install requirements-scoreboard.txt before running the worker."
        )
    return cv2


def _positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a positive integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as reason:
        raise ValueError(f"{label} must be a positive integer") from reason
    if number <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return number


def _fraction(value: object, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as reason:
        raise ValueError(f"{label} must be between 0 and 1") from reason
    if not 0 <= number <= 1:
        raise ValueError(f"{label} must be between 0 and 1")
    return number


def _rect(value: object, coordinate_space: int, label: str) -> tuple[int, int, int, int]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{label} must be [x, y, width, height]")
    x, y, width, height = (
        _positive_integer(item, label) if index >= 2 else int(item)
        for index, item in enumerate(value)
    )
    if x < 0 or y < 0 or x + width > coordinate_space or y + height > coordinate_space:
        raise ValueError(f"{label} exceeds the configured coordinate space")
    return x, y, width, height


def validate_layout(layout: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(layout, dict):
        raise ValueError("layout must be a JSON object")
    if not str(layout.get("id") or "").strip():
        raise ValueError("layout.id is required")
    _positive_integer(layout.get("version"), "layout.version")
    coordinate_space = _positive_integer(
        layout.get("coordinate_space"), "layout.coordinate_space"
    )
    reference = layout.get("reference_size")
    if not isinstance(reference, dict):
        raise ValueError("layout.reference_size is required")
    _positive_integer(reference.get("width"), "layout.reference_size.width")
    _positive_integer(reference.get("height"), "layout.reference_size.height")
    _fraction(layout.get("aspect_ratio_tolerance"), "layout.aspect_ratio_tolerance")
    _rect(layout.get("leaderboard_region"), coordinate_space, "layout.leaderboard_region")

    rows = layout.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("layout.rows must contain at least one row")
    if len(rows) > 25:
        raise ValueError("layout.rows cannot contain more than 25 rows")
    for index, row in enumerate(rows):
        _rect(row, coordinate_space, f"layout.rows[{index}]")

    placement_hints = layout.get("placement_hints", {})
    if not isinstance(placement_hints, dict):
        raise ValueError("layout.placement_hints must be an object")
    for raw_row_index, raw_placement in placement_hints.items():
        try:
            row_index = int(raw_row_index)
        except (TypeError, ValueError) as reason:
            raise ValueError("layout.placement_hints keys must be row indexes") from reason
        if row_index < 0 or row_index >= len(rows):
            raise ValueError("layout.placement_hints contains an unknown row index")
        _positive_integer(
            raw_placement,
            f"layout.placement_hints.{raw_row_index}",
        )

    columns = layout.get("columns")
    if not isinstance(columns, dict):
        raise ValueError("layout.columns is required")
    for name in ("placement", "slot", "kills"):
        _rect(columns.get(name), coordinate_space, f"layout.columns.{name}")
    if "slot_color" in columns:
        _rect(
            columns.get("slot_color"),
            coordinate_space,
            "layout.columns.slot_color",
        )

    palette = layout.get("slot_color_palette", {})
    if not isinstance(palette, dict):
        raise ValueError("layout.slot_color_palette must be an object")
    for slot, hsv in palette.items():
        if not isinstance(slot, str) or len(slot) != 1 or not "A" <= slot <= "Y":
            raise ValueError("layout.slot_color_palette keys must be A-Y")
        if not isinstance(hsv, list) or len(hsv) != 3:
            raise ValueError(
                f"layout.slot_color_palette.{slot} must be [hue, saturation, value]"
            )
        hue, saturation, value = (int(item) for item in hsv)
        if not 0 <= hue <= 179 or not 0 <= saturation <= 255 or not 0 <= value <= 255:
            raise ValueError(f"layout.slot_color_palette.{slot} is outside HSV bounds")

    ocr = layout.get("ocr")
    if not isinstance(ocr, dict):
        raise ValueError("layout.ocr is required")
    _positive_integer(ocr.get("upscale"), "layout.ocr.upscale")
    if not isinstance(ocr.get("fast_mode", False), bool):
        raise ValueError("layout.ocr.fast_mode must be a boolean")
    _fraction(ocr.get("minimum_confidence"), "layout.ocr.minimum_confidence")
    _fraction(
        ocr.get("sequence_anchor_confidence"),
        "layout.ocr.sequence_anchor_confidence",
    )
    _fraction(
        ocr.get("placement_hint_confidence", 0.95),
        "layout.ocr.placement_hint_confidence",
    )
    _positive_integer(ocr.get("max_placement"), "layout.ocr.max_placement")
    _positive_integer(ocr.get("max_kills"), "layout.ocr.max_kills")
    parallel_workers = _positive_integer(
        ocr.get("parallel_workers", 1),
        "layout.ocr.parallel_workers",
    )
    if parallel_workers > 8:
        raise ValueError("layout.ocr.parallel_workers cannot exceed 8")
    alternate_layouts = layout.get("alternate_layouts", [])
    if not isinstance(alternate_layouts, list):
        raise ValueError("layout.alternate_layouts must be a list")
    for alternate in alternate_layouts:
        if not isinstance(alternate, str) or not alternate.strip():
            raise ValueError("layout.alternate_layouts entries must be filenames")
        alternate_path = Path(alternate)
        if alternate_path.is_absolute() or ".." in alternate_path.parts:
            raise ValueError("layout.alternate_layouts entries must remain beside the layout")
    return layout


def load_layout(filename: str | Path) -> dict[str, Any]:
    path = Path(filename)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as reason:
        raise ValueError(f"scoreboard layout is not valid JSON: {path}") from reason
    return validate_layout(payload)


def select_layout_for_image(
    primary_filename: str | Path,
    image: np.ndarray,
) -> dict[str, Any]:
    """Select the closest configured fixed layout without using image recognition."""

    primary_path = Path(primary_filename)
    primary = load_layout(primary_path)
    candidates = [primary]
    for alternate_filename in primary.get("alternate_layouts", []):
        candidates.append(load_layout(primary_path.parent / alternate_filename))

    image_height, image_width = image.shape[:2]
    actual_ratio = image_width / image_height

    def aspect_difference(candidate: dict[str, Any]) -> float:
        reference = candidate["reference_size"]
        reference_ratio = int(reference["width"]) / int(reference["height"])
        return abs(actual_ratio - reference_ratio) / reference_ratio

    return min(candidates, key=aspect_difference)


def load_image(filename: str | Path) -> LoadedImage:
    active_cv2 = require_opencv()
    path = Path(filename)
    original = path.read_bytes()
    if not original:
        raise ValueError("screenshot file is empty")
    encoded = np.frombuffer(original, dtype=np.uint8)
    pixels = active_cv2.imdecode(encoded, active_cv2.IMREAD_COLOR)
    if pixels is None or pixels.size == 0:
        raise ValueError("screenshot is not a supported PNG, JPG, JPEG, or WEBP image")
    return LoadedImage(
        path=path,
        original_bytes=original,
        original_sha256=hashlib.sha256(original).hexdigest(),
        pixels=pixels,
    )


def normalize_image(image: np.ndarray, layout: dict[str, Any]) -> np.ndarray:
    active_cv2 = require_opencv()
    reference_width = int(layout["reference_size"]["width"])
    reference_height = int(layout["reference_size"]["height"])
    image_height, image_width = image.shape[:2]
    actual_ratio = image_width / image_height
    reference_ratio = reference_width / reference_height
    relative_difference = abs(actual_ratio - reference_ratio) / reference_ratio
    if relative_difference > float(layout["aspect_ratio_tolerance"]):
        raise ValueError(
            "screenshot aspect ratio does not match the configured fixed layout"
        )
    return active_cv2.resize(
        image,
        (reference_width, reference_height),
        interpolation=active_cv2.INTER_LANCZOS4,
    )


def normalized_rect_to_pixels(
    rect: list[int] | tuple[int, int, int, int],
    width: int,
    height: int,
    coordinate_space: int,
) -> tuple[int, int, int, int]:
    x, y, rect_width, rect_height = rect
    left = max(0, min(width - 1, round((x / coordinate_space) * width)))
    top = max(0, min(height - 1, round((y / coordinate_space) * height)))
    right = max(
        left + 1,
        min(width, round(((x + rect_width) / coordinate_space) * width)),
    )
    bottom = max(
        top + 1,
        min(height, round(((y + rect_height) / coordinate_space) * height)),
    )
    return left, top, right - left, bottom - top


def _crop(image: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray:
    x, y, width, height = bbox
    cropped = image[y : y + height, x : x + width]
    if cropped.size == 0:
        raise ValueError(f"fixed crop is empty: {bbox}")
    return cropped


def crop_scoreboard_fields(
    normalized: np.ndarray,
    layout: dict[str, Any],
) -> list[FieldCrop]:
    coordinate_space = int(layout["coordinate_space"])
    image_height, image_width = normalized.shape[:2]
    leaderboard_bbox = normalized_rect_to_pixels(
        layout["leaderboard_region"],
        image_width,
        image_height,
        coordinate_space,
    )
    leaderboard = _crop(normalized, leaderboard_bbox)
    leaderboard_height, leaderboard_width = leaderboard.shape[:2]
    output: list[FieldCrop] = []

    for row_index, row_rect in enumerate(layout["rows"]):
        row_bbox = normalized_rect_to_pixels(
            row_rect,
            leaderboard_width,
            leaderboard_height,
            coordinate_space,
        )
        row_pixels = _crop(leaderboard, row_bbox)
        row_height, row_width = row_pixels.shape[:2]
        configured_fields = ["placement", "slot", "kills"]
        if "slot_color" in layout["columns"]:
            configured_fields.append("slot_color")
        for field in configured_fields:
            local_bbox = normalized_rect_to_pixels(
                layout["columns"][field],
                row_width,
                row_height,
                coordinate_space,
            )
            local_x, local_y, local_width, local_height = local_bbox
            absolute_bbox = (
                leaderboard_bbox[0] + row_bbox[0] + local_x,
                leaderboard_bbox[1] + row_bbox[1] + local_y,
                local_width,
                local_height,
            )
            output.append(
                FieldCrop(
                    row_index=row_index,
                    field=field,
                    bbox=absolute_bbox,
                    pixels=_crop(row_pixels, local_bbox),
                )
            )
    return output


def preprocessing_variants(
    crop: np.ndarray,
    *,
    upscale: int,
    field: str | None = None,
) -> dict[str, np.ndarray]:
    """Return independent local variants for OCR consensus."""

    active_cv2 = require_opencv()
    if field == "slot":
        scaled = active_cv2.resize(
            crop,
            None,
            fx=upscale,
            fy=upscale,
            interpolation=active_cv2.INTER_CUBIC,
        )
        vertical_margin = max(1, crop.shape[0] // 10)
        inner = crop[vertical_margin : crop.shape[0] - vertical_margin]
        inner_scaled = active_cv2.resize(
            inner,
            None,
            fx=upscale,
            fy=upscale,
            interpolation=active_cv2.INTER_CUBIC,
        )

        def color_bordered(value: np.ndarray) -> np.ndarray:
            return active_cv2.copyMakeBorder(
                value,
                20,
                20,
                20,
                20,
                active_cv2.BORDER_CONSTANT,
                value=(255, 255, 255),
            )

        return {
            "raw": color_bordered(scaled),
            "inner": color_bordered(inner_scaled),
        }

    if crop.ndim == 3:
        grayscale = active_cv2.cvtColor(crop, active_cv2.COLOR_BGR2GRAY)
    else:
        grayscale = crop.copy()
    if field == "kills":
        masks = {
            "gray_160": np.where(grayscale > 160, 255, 0).astype(np.uint8),
            "gray_200": np.where(grayscale > 200, 255, 0).astype(np.uint8),
            "otsu": active_cv2.threshold(
                grayscale,
                0,
                255,
                active_cv2.THRESH_BINARY + active_cv2.THRESH_OTSU,
            )[1],
        }

        def clean_numeric_mask(value: np.ndarray) -> np.ndarray:
            value = isolate_kill_digits(value)
            y_points, x_points = np.where(value > 0)
            if len(x_points):
                left = max(0, int(x_points.min()) - 1)
                right = min(value.shape[1], int(x_points.max()) + 2)
                top = max(0, int(y_points.min()) - 1)
                bottom = min(value.shape[0], int(y_points.max()) + 2)
                value = value[top:bottom, left:right]
            scaled_mask = active_cv2.resize(
                value,
                None,
                fx=upscale,
                fy=upscale,
                interpolation=active_cv2.INTER_CUBIC,
            )
            return active_cv2.copyMakeBorder(
                active_cv2.bitwise_not(scaled_mask),
                24,
                24,
                24,
                24,
                active_cv2.BORDER_CONSTANT,
                value=255,
            )

        return {
            name: clean_numeric_mask(mask)
            for name, mask in masks.items()
        }

    scaled = active_cv2.resize(
        grayscale,
        None,
        fx=upscale,
        fy=upscale,
        interpolation=active_cv2.INTER_CUBIC,
    )
    denoised = active_cv2.fastNlMeansDenoising(scaled, None, 7, 7, 21)
    contrasted = active_cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 4)).apply(
        denoised
    )
    sharpened = active_cv2.filter2D(
        contrasted,
        -1,
        np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32),
    )
    _, otsu = active_cv2.threshold(
        sharpened, 0, 255, active_cv2.THRESH_BINARY + active_cv2.THRESH_OTSU
    )
    adaptive = active_cv2.adaptiveThreshold(
        sharpened,
        255,
        active_cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        active_cv2.THRESH_BINARY,
        31,
        7,
    )

    def bordered(value: np.ndarray) -> np.ndarray:
        return active_cv2.copyMakeBorder(
            value,
            12,
            12,
            12,
            12,
            active_cv2.BORDER_CONSTANT,
            value=255,
        )

    return {
        "sharpened": bordered(sharpened),
        "otsu": bordered(otsu),
        "inverted_otsu": bordered(active_cv2.bitwise_not(otsu)),
        "adaptive": bordered(adaptive),
    }


def isolate_kill_digits(mask: np.ndarray) -> np.ndarray:
    """Remove the fixed skull icon to the left of its adjacent kill number."""

    active_cv2 = require_opencv()
    output = mask.copy()
    width = output.shape[1]
    height = output.shape[0]

    def components_for(value: np.ndarray) -> list[tuple[int, ...]]:
        component_count, _labels, stats, _centroids = (
            active_cv2.connectedComponentsWithStats(value)
        )
        return [
            tuple(int(item) for item in stats[index])
            for index in range(1, component_count)
            if int(stats[index][active_cv2.CC_STAT_AREA]) >= 3
        ]

    components = components_for(output)
    for component in components:
        left = component[active_cv2.CC_STAT_LEFT]
        top = component[active_cv2.CC_STAT_TOP]
        component_width = component[active_cv2.CC_STAT_WIDTH]
        component_height = component[active_cv2.CC_STAT_HEIGHT]
        area = component[active_cv2.CC_STAT_AREA]
        if (
            area < max(4, round(width * height * 0.003))
            or (
                component_width <= max(2, round(width * 0.04))
                and component_height >= height * 0.7
            )
        ):
            output[
                top : top + component_height,
                left : left + component_width,
            ] = 0
    components = components_for(output)
    if len(components) < 2:
        return output
    left_components = [
        component
        for component in components
        if (
            component[active_cv2.CC_STAT_LEFT] < width * 0.55
            and component[active_cv2.CC_STAT_WIDTH] >= max(3, width * 0.18)
            and component[active_cv2.CC_STAT_HEIGHT] >= max(5, height * 0.25)
        )
    ]
    if not left_components:
        return output
    skull = max(
        left_components,
        key=lambda component: component[active_cv2.CC_STAT_AREA],
    )
    other_areas = [
        component[active_cv2.CC_STAT_AREA]
        for component in components
        if component != skull
    ]
    if (
        not other_areas
        or skull[active_cv2.CC_STAT_AREA] < max(other_areas) * 1.8
    ):
        return output
    skull_right = (
        skull[active_cv2.CC_STAT_LEFT]
        + skull[active_cv2.CC_STAT_WIDTH]
    )
    output[:, : min(width, skull_right + 1)] = 0
    return output
