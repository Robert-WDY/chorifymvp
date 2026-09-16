import unicodedata


def _normalize(value):
    return unicodedata.normalize("NFC", value or "")


def _duplicates(values):
    seen = set()
    duplicates = set()
    for value in values:
        key = _normalize(value).strip().casefold()
        if key in seen:
            duplicates.add(value)
        seen.add(key)
    return sorted(duplicates)


def main(input: dict):
    prompt = _normalize(input.get("prompt", ""))
    aspect_ratio = _normalize(input.get("aspectRatio", ""))
    exact_texts = [_normalize(value) for value in input.get("exactTexts", [])]
    required_literals = [_normalize(value) for value in input.get("requiredLiterals", [])]
    forbidden_literals = [_normalize(value) for value in input.get("forbiddenLiterals", [])]
    roles = input.get("referenceRoles", [])

    missing_exact = [value for value in exact_texts if value not in prompt]
    missing_required = [value for value in required_literals if value not in prompt]
    found_forbidden = [value for value in forbidden_literals if value and value in prompt]
    duplicate_reference_ids = _duplicates([item.get("referenceId", "") for item in roles])
    duplicate_roles = _duplicates([item.get("role", "") for item in roles])
    errors = []
    warnings = []

    if not prompt.strip():
        errors.append("prompt 不能为空")
    if aspect_ratio and aspect_ratio not in prompt:
        errors.append("提示词缺少指定画幅")
    if missing_exact:
        errors.append("提示词未逐字包含全部封面文字")
    if missing_required:
        errors.append("提示词缺少必须保持项")
    if found_forbidden:
        errors.append("提示词包含禁止内容")
    if duplicate_reference_ids:
        errors.append("同一参考图被重复声明")
    if duplicate_roles:
        warnings.append("多张参考图承担相同主要职责，请确认不会冲突")
    if exact_texts and "安全区" not in prompt and "safe area" not in prompt.lower():
        warnings.append("提示词包含封面文字，但没有明确文字安全区")
    if len(exact_texts) > 2:
        warnings.append("封面文字超过两层，图片模型的排版稳定性可能下降")

    normalized_roles = [
        {
            "referenceId": item.get("referenceId", "").strip(),
            "role": item.get("role", "").strip(),
            "priority": item.get("priority", 50),
        }
        for item in roles
    ]
    normalized_roles.sort(key=lambda item: (item["priority"], item["referenceId"]))

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "checks": {
            "promptLength": len(prompt),
            "missingExactTexts": missing_exact,
            "missingRequiredLiterals": missing_required,
            "foundForbiddenLiterals": found_forbidden,
            "duplicateReferenceIds": duplicate_reference_ids,
            "duplicateRoles": duplicate_roles,
        },
        "normalizedReferenceRoles": normalized_roles,
    }

