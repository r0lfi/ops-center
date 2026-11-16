import re

from app.services.claude_memory_import import KEY_PREFIX, build_notes, chunk_text, parse_memory_file

# worker_ai/ai/memory.py::remember's key rule; imported keys must satisfy it too.
KEY_RE = re.compile(r"[a-zA-Z0-9_.-]{1,100}")

NOTE = """---
name: homelab-topology
description: "hosts, what runs where"
metadata:
  type: project
---

**docker-host-01** runs Ops Center.

password: hunter2 should never be imported
The API token = abc123 is also dropped.

""" + "\n\n".join(f"Paragraph {i}: " + "word " * 60 for i in range(12))


def test_parse_frontmatter_ignores_nested_keys():
    name, description, body = parse_memory_file(NOTE, "fallback")
    assert name == "homelab-topology" and description == "hosts, what runs where"
    assert body.startswith("**docker-host-01**") and "type: project" not in body


def test_missing_frontmatter_uses_filename():
    assert parse_memory_file("just text", "my_file")[:2] == ("my_file", "")


def test_chunks_respect_limit_and_keep_all_text():
    body = "\n\n".join(["a" * 400, "b " * 700, "c" * 50])
    chunks = chunk_text(body, 500)
    assert all(len(c) <= 500 for c in chunks)
    assert "".join(chunks).replace("\n", "").replace(" ", "") == body.replace("\n", "").replace(" ", "")


def test_build_notes_keys_bounds_and_secret_filter():
    notes, dropped = build_notes({"homelab_topology.md": NOTE, "MEMORY.md": "- [Topology](homelab_topology.md) - hosts"})
    assert dropped == 2
    assert not any("hunter2" in v or "abc123" in v for v in notes.values())
    assert all(k.startswith(KEY_PREFIX) and KEY_RE.fullmatch(k) for k in notes)
    assert all(len(v) <= 1000 for v in notes.values())
    topo = sorted(k for k in notes if k.startswith("claude.homelab-topology."))
    assert len(topo) > 1 and topo[0] == "claude.homelab-topology.01"
    assert notes[topo[0]].startswith("[Claude memory: homelab-topology] hosts, what runs where (part 1/")
    assert "docker-host-01" in notes[topo[0]]
    assert "claude.index.01" in notes and "Topology" in notes["claude.index.01"]


def test_build_notes_is_deterministic():
    files = {"b.md": NOTE, "a.md": "---\nname: a\n---\nshort"}
    assert build_notes(files) == build_notes(dict(reversed(list(files.items()))))


def test_empty_body_produces_no_notes():
    assert build_notes({"empty.md": "---\nname: empty\n---\n"}) == ({}, 0)
