import re
import unicodedata


NUMBER_WORDS = {
    2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
}


PHASE_MARKERS = {
    "person-anchor": ("front-facing", "full-body"),
    "person-lock": ("front full body", "own right side", "back full body", "face close-up"),
    "environment-plan": ("top-down", "orthographic"),
    "environment-lock": ("2-column", "2-row"),
    "product-lock": ("front", "own right side", "back"),
}


def _normalize(value):
    return unicodedata.normalize("NFC", value or "")


def main(input: dict):
    phase = input.get("phase", "")
    prompt = _normalize(input.get("prompt", ""))
    prompt_lower = prompt.lower()
    expected_panels = input.get("expectedPanelCount", 0)
    required_literals = [_normalize(value) for value in input.get("requiredLiterals", [])]
    forbidden_literals = [_normalize(value) for value in input.get("forbiddenLiterals", [])]
    requires_no_added_text = input.get("requiresNoAddedText", True)
    errors = []
    warnings = []

    missing_required = [value for value in required_literals if value not in prompt]
    found_forbidden = [value for value in forbidden_literals if value and value in prompt]
    placeholders = re.findall(r"\[[^\]\n]{1,200}\]", prompt)
    markers = PHASE_MARKERS.get(phase, ())
    missing_markers = [value for value in markers if value not in prompt_lower]

    if not prompt.strip():
        errors.append("prompt 不能为空")
    if phase not in PHASE_MARKERS:
        errors.append("phase 无效")
    if missing_markers:
        errors.append("提示词缺少当前阶段的固定结构标记")
    if expected_panels > 1:
        word = NUMBER_WORDS.get(expected_panels, "")
        count_markers = (
            "exactly %d" % expected_panels,
            "exactly " + word if word else "",
            "%d panels" % expected_panels,
            "%d格" % expected_panels,
            "%d 格" % expected_panels,
        )
        if not any(value and value in prompt_lower for value in count_markers):
            errors.append("提示词未明确写出预期画格数")
    if missing_required:
        errors.append("提示词缺少必须保留内容")
    if found_forbidden:
        errors.append("提示词包含禁止内容")
    if placeholders:
        errors.append("提示词仍包含未替换的方括号占位符")

    no_text_markers = (
        "no added text", "no text", "do not add editorial text",
        "不新增文字", "无文字", "禁止文字",
    )
    if requires_no_added_text and not any(value in prompt_lower for value in no_text_markers):
        errors.append("提示词缺少禁止新增说明文字的合同")

    if phase == "product-lock" and "no hands" not in prompt_lower and "无手" not in prompt:
        warnings.append("产品三视图需要明确无手；手只能出现在交互格")
    if len(prompt) > 12000:
        warnings.append("提示词较长，请压缩重复描述但不要删除结构与证据约束")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "checks": {
            "promptLength": len(prompt),
            "expectedPanelCount": expected_panels,
            "missingPhaseMarkers": missing_markers,
            "missingRequiredLiterals": missing_required,
            "foundForbiddenLiterals": found_forbidden,
            "unfilledPlaceholders": placeholders,
        },
    }

