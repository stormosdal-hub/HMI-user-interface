"""Tabs: a layout holds one or more tabs, each with its own elements. A display
shows one of them, the active tab, and the inputs on the RaspiPower board
(INN0–INN7) move between them as the layout's "nav" says:

    "tabs": [{"id": "t1", "name": "Motor", "elements": [...]}, ...],
    "nav":  [{"input": 0, "action": "next"}, {"input": 2, "action": "goto", "tab": "t3"}]

Layouts from before tabs have their elements at the top level; they are one tab.
"""

ACTIONS = {
    "next": "Neste fane",
    "prev": "Forrige fane",
    "goto": "Gå til fanen",
    "hold": "Vis fanen mens inngangen er på",
}

# Sources for a tab's own number and name ({tab}/{tab_count} …); every display fills them in for its own tab.
TAB_META = {
    "tab": {"label": "Fanen som vises (nr.)", "group": "Faner"},
    "tab_count": {"label": "Antall faner", "group": "Faner"},
    "tab_name": {"label": "Navnet på fanen", "group": "Faner"},
}


def tabs_of(layout):
    tabs = layout.get("tabs")
    if isinstance(tabs, list) and tabs:
        return tabs
    return [{"id": "", "name": "", "elements": layout.get("elements") or []}]


def tab_index(layout, tab_id):
    """The index of the tab with this id, or None."""
    for i, tab in enumerate(tabs_of(layout)):
        if tab_id and tab.get("id") == tab_id:
            return i
    return None


def tab_names(layout):
    return [str(t.get("name") or "").strip() or f"Fane {i + 1}" for i, t in enumerate(tabs_of(layout))]


def page(layout, index):
    """The tab at index as a layout of its own, which is what the renderers take, and its values for {tab} …"""
    tabs = tabs_of(layout)
    i = max(0, min(int(index), len(tabs) - 1))
    out = {k: v for k, v in layout.items() if k not in ("tabs", "nav")}
    out["elements"] = tabs[i].get("elements") or []
    return out, {"tab": i + 1, "tab_count": len(tabs), "tab_name": tab_names(layout)[i]}


def check(layout, inputs):
    """Raises ValueError if the tabs or the inputs' actions can't be used. inputs = how many there are."""
    tabs = layout.get("tabs")
    if tabs is not None:
        if not isinstance(tabs, list) or not tabs:
            raise ValueError("Layouten har ingen faner.")
        if not all(isinstance(t, dict) and isinstance(t.get("elements", []), list) for t in tabs):
            raise ValueError("En av fanene i layouten er ødelagt.")
    nav = layout.get("nav") or []
    if not isinstance(nav, list):
        raise ValueError("«nav» i layouten må være en liste.")
    seen = set()
    for b in nav:
        n = b.get("input") if isinstance(b, dict) else None
        if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n < inputs:
            raise ValueError(f"Inngangen {n!r} finnes ikke (INN0–INN{inputs - 1}).")
        if n in seen:
            raise ValueError(f"INN{n} har flere handlinger; den kan bare ha én.")
        seen.add(n)
        if b.get("action") not in ACTIONS:
            raise ValueError(f"INN{n}: ukjent handling {b.get('action')!r}.")
        if b["action"] in ("goto", "hold") and tab_index(layout, b.get("tab")) is None:
            raise ValueError(f"INN{n}: fanen den skal vise, finnes ikke i layouten.")


def nav_of(layout):
    """{input: (action, tab index or None)} for a layout that has passed check()."""
    out = {}
    for b in layout.get("nav") or []:
        out[b["input"]] = (b["action"], tab_index(layout, b.get("tab")))
    return out
