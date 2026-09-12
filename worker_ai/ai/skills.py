"""Small versioned task routines; advice never grants tools or permission."""

from pathlib import Path

ROOT = Path(__file__).with_name("skills")
ROUTINES = {
    "resources": ("disk", "cpu", "minne", "memory", "oom", "load", "treg", "full"),
    "media-security": (
        "media",
        "jellyfin",
        "security",
        "sikker",
        "angrep",
        "innlogging",
    ),
}


def task_routines(message):
    text = message.lower()
    selected = [
        name for name, terms in ROUTINES.items() if any(term in text for term in terms)
    ]
    return "\n".join((ROOT / (name + ".md")).read_text() for name in selected[:2])
