"""Safe "{source:.1f}"-style templating for text elements.

Only plain lookups in the values dict are allowed – no attribute or index
access – so a layout can't reach into Python objects.
"""

import string

_formatter = string.Formatter()
MISSING = "--"


def format_value(value, decimals=None):
    if value is None:
        return MISSING
    if isinstance(value, bool):
        return "1" if value else "0"  # a bit from the PLC, as the HMI shows it
    if isinstance(value, (int, float)):
        if decimals is not None and decimals != "":
            return f"{value:.{int(decimals)}f}"
        if isinstance(value, float):
            return f"{value:.1f}"
    return str(value)


def value_text(el, value):
    """What a value element shows: a bit's own text when the element has one ("Åpen"/"Lukket")."""
    if isinstance(value, bool):
        text = el.get("true_text" if value else "false_text")
        if text not in (None, ""):
            return str(text)
    return format_value(value, None if isinstance(value, str) else el.get("decimals"))


def render_template(template, values):
    try:
        parts = list(_formatter.parse(template))
    except ValueError:
        return template  # unbalanced braces: show as-is
    out = []
    for literal, field, spec, _conv in parts:
        out.append(literal)
        if field is None:
            continue
        value = values.get(field)
        if value is None:
            out.append(MISSING)
        elif spec:
            if isinstance(value, bool):
                value = int(value)
            try:
                out.append(format(value, spec))
            except (ValueError, TypeError):
                out.append(str(value))
        else:
            out.append(format_value(value))
    return "".join(out)
