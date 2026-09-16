import re


def main(input: dict):
    if not isinstance(input, dict):
        raise ValueError("input must be an object")

    prompt = input.get("prompt")
    panel_count = input.get("panelCount")
    columns = input.get("columns")
    rows = input.get("rows")
    aspect_ratio = input.get("aspectRatio", "")

    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")
    for name, value in (("panelCount", panel_count), ("columns", columns), ("rows", rows)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(name + " must be an integer")
    if not isinstance(aspect_ratio, str):
        raise ValueError("aspectRatio must be a string")
    if panel_count < 3 or panel_count > 24:
        raise ValueError("panelCount must be between 3 and 24")
    if columns < 1 or columns > 6:
        raise ValueError("columns must be between 1 and 6")
    if rows < 1 or rows > 24:
        raise ValueError("rows must be between 1 and 24")

    errors = []
    warnings = []
    expected_rows = (panel_count + columns - 1) // columns

    if rows != expected_rows:
        errors.append("rows 必须等于 panelCount ÷ columns 向上取整")
    if panel_count > columns * rows:
        errors.append("网格容量小于宫格总数")
    if rows > 1 and panel_count <= columns * (rows - 1):
        errors.append("网格包含一整行不必要的空位")

    matches = list(re.finditer(r"【Panel\s+(\d{2})】", prompt))
    detected_numbers = [int(match.group(1)) for match in matches]
    expected_numbers = list(range(1, panel_count + 1))

    if len(matches) != panel_count:
        errors.append("检测到的 Panel 数量与 panelCount 不一致")
    if detected_numbers != expected_numbers:
        errors.append("Panel 编号必须从 01 开始连续递增且不得重复")

    missing_captions = []
    long_captions = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(prompt)
        block = prompt[match.end():end]
        caption_match = re.search(r"底部说明[：:]\s*([^\r\n]+)", block)
        panel_number = detected_numbers[index]
        if caption_match is None or not caption_match.group(1).strip():
            missing_captions.append(panel_number)
        elif len(caption_match.group(1).strip()) > 24:
            long_captions.append(panel_number)

    if missing_captions:
        errors.append("以下 Panel 缺少底部说明：" + ", ".join(str(value) for value in missing_captions))
    if long_captions:
        warnings.append("以下 Panel 的底部说明超过 24 个字符：" + ", ".join(str(value) for value in long_captions))

    compact_prompt = re.sub(r"\s+", "", prompt)
    grid_forms = (
        str(columns) + "列×" + str(rows) + "行",
        str(columns) + "列x" + str(rows) + "行",
        str(columns) + "列X" + str(rows) + "行",
    )
    if not any(form in compact_prompt for form in grid_forms):
        errors.append("总提示词未明确写出与参数一致的网格")
    if "一张完整多宫格故事板" not in prompt and "一张完整故事板" not in prompt:
        errors.append("总提示词未明确要求生成一张完整故事板")
    if "禁止拆图" not in prompt:
        warnings.append("建议明确写出“禁止拆图”")
    if "【全局连续性】" not in prompt:
        errors.append("缺少【全局连续性】段落")
    if "【最终复核】" not in prompt:
        errors.append("缺少【最终复核】段落")
    if not aspect_ratio.strip():
        warnings.append("未提供整版 aspectRatio")

    valid = len(errors) == 0
    return {
        "valid": valid,
        "readyForGeneration": valid,
        "expectedPanelCount": panel_count,
        "detectedPanelCount": len(matches),
        "detectedPanelNumbers": detected_numbers,
        "grid": {
            "columns": columns,
            "rows": rows,
            "capacity": columns * rows,
        },
        "errors": errors,
        "warnings": warnings,
    }
