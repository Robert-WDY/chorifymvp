import re
import unicodedata


CAMERA_TOKENS = (
    "LOCKED", "PUSH", "PULL", "PAN", "TILT", "TRACK", "DOLLY",
    "TRUCK", "CRANE", "ARC", "ORBIT", "HANDHELD", "WHIP", "ZOOM",
)

REQUIRED_FIELDS = (
    "分镜功能", "景别", "机位", "镜头运动", "角色台词", "VO", "环境声/音效", "音乐",
)


def _normalize(value):
    return unicodedata.normalize("NFC", value or "")


def main(input: dict):
    prompt = _normalize(input.get("prompt", ""))
    panel_count = input.get("expectedPanelCount", 0)
    layout = _normalize(input.get("layout", ""))
    aspect_ratio = _normalize(input.get("aspectRatio", ""))
    shot_ids = [_normalize(value) for value in input.get("shotIds", [])]
    required_literals = [_normalize(value) for value in input.get("requiredLiterals", [])]
    forbidden_literals = [_normalize(value) for value in input.get("forbiddenLiterals", [])]

    errors = []
    warnings = []
    missing_shot_ids = [value for value in shot_ids if value not in prompt]
    missing_literals = [value for value in required_literals if value not in prompt]
    found_forbidden = [value for value in forbidden_literals if value and value in prompt]
    missing_fields = [value for value in REQUIRED_FIELDS if value not in prompt]
    placeholders = re.findall(
        r"\[[^\]\n]*(?:编号|起始|结束|项目名|时间范围|本段时长|短标题|逐字|按实际|待填|TODO|\.\.\.)[^\]\n]*\]",
        prompt,
        flags=re.IGNORECASE,
    )

    if not prompt.strip():
        errors.append("prompt 不能为空")
    if "一张图" not in prompt:
        errors.append("缺少‘一张图完成’硬约束")
    panel_patterns = (
        "严格 %d 个" % panel_count,
        "%d 个独立画格" % panel_count,
        "%d格" % panel_count,
        "%d 格" % panel_count,
    )
    if panel_count > 0 and not any(value in prompt for value in panel_patterns):
        errors.append("未明确写出严格画格数")
    if layout and layout not in prompt:
        errors.append("提示词缺少指定布局")
    if aspect_ratio and aspect_ratio not in prompt:
        errors.append("提示词缺少指定画幅")
    if missing_shot_ids:
        errors.append("提示词缺少一个或多个镜号")
    if missing_literals:
        errors.append("提示词未逐字保留必要文字")
    if found_forbidden:
        errors.append("提示词包含禁止文字")
    if missing_fields:
        errors.append("提示词缺少一个或多个画下制作字段")
    if placeholders:
        errors.append("提示词仍包含未替换的方括号占位符")

    missing_camera_states = []
    for index, shot_id in enumerate(shot_ids):
        start = prompt.find(shot_id)
        if start < 0:
            continue
        end = len(prompt)
        if index + 1 < len(shot_ids):
            next_start = prompt.find(shot_ids[index + 1], start + len(shot_id))
            if next_start >= 0:
                end = next_start
        section = prompt[start:end].upper()
        if not any(token in section for token in CAMERA_TOKENS):
            missing_camera_states.append(shot_id)
    if missing_camera_states:
        errors.append("一个或多个画格缺少摄影机状态")

    if len(prompt) < 1000:
        warnings.append("执行提示词可能过短，请确认连续性和制作字段没有被过度压缩")
    if len(prompt) > 12000:
        warnings.append("执行提示词过长，建议压缩重复解释后再生图")
    if "箭头图例" not in prompt:
        warnings.append("提示词未明确要求底部箭头图例")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "checks": {
            "promptLength": len(prompt),
            "expectedPanelCount": panel_count,
            "missingShotIds": missing_shot_ids,
            "missingRequiredLiterals": missing_literals,
            "foundForbiddenLiterals": found_forbidden,
            "missingProductionFields": missing_fields,
            "unfilledPlaceholders": placeholders,
            "missingCameraStates": missing_camera_states,
        },
    }
