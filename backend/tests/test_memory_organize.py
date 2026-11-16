"""Import & Organize: sections, credential removal, validation, dedupe and comparison."""
import uuid
from types import SimpleNamespace as NS

from app.services.memory_organize import (SECTION_CHARS, clean_section, compare, dedupe, index_for, normalize,
                                          parse_memories, split_sections)
from app.services.memory_store import duplicate_pairs, note_problem, similarity

NOVA = uuid.uuid4()


def note(key, content, agent_id=None, category=None, kind=None):
    return NS(id=uuid.uuid4(), key=key, content=content, agent_id=agent_id, category=category, kind=kind)


def test_sections_follow_headings_and_stay_bounded():
    text = "# Me\nI live in Springfield.\n\n## Work\n" + "\n\n".join(f"Paragraph {i}. " + "word " * 300 for i in range(20))
    sections = split_sections(text)
    assert sections[0].startswith("# Me") and all(len(s) <= SECTION_CHARS for s in sections) and len(sections) > 2
    assert "".join(sections).replace("\n", "").replace(" ", "") == text.replace("\n", "").replace(" ", "")
    assert split_sections("   ") == []
    ordered = split_sections("# Life\nI live in Springfield.\n\n" + "filler " * 1300 + "\n\n# Lab\nProxmox.")
    assert ordered[0] == "# Life\nI live in Springfield." and ordered[-1].endswith("# Lab\nProxmox.") and len(ordered) == 3


def test_credentials_never_reach_the_model():
    cleaned, removed = clean_section("Runs Proxmox.\napi_key = aaaaaaaa\nUses Ansible.")
    assert cleaned == "Runs Proxmox.\nUses Ansible." and removed == 1


def test_model_output_is_parsed_and_validated_like_an_owner_note():
    raw = 'Here: {"memories": [{"key": "Career / Current Employer!", "category": "  Career  &  Work ", "kind": "job", "scope": "shared", '\
          '"content": "Works at Example AS.", "updates_key": "career.employer"}, {"key": "x", "content": "token: aaaaaaaa"}, "junk"]}'
    items = parse_memories(raw)
    assert len(items) == 2 and parse_memories("no json") is None and parse_memories('{"memories": []}') == []
    good, _ = normalize(items[0], 3)
    assert good == {"key": "career_current_employer", "category": "Career & Work", "kind": "fact", "content": "Works at Example AS.",
                    "updates_key": "career.employer", "suggested_scope": "shared", "section": 3}
    assert normalize(items[1], 0) == (None, "Notes cannot contain credentials such as passwords, tokens or private keys.")


def test_dedupe_merges_same_key_and_drops_identical_text():
    proposals = [{"key": "family", "content": "Married to Alex.", "suggested_scope": "nova"},
                 {"key": "family", "content": "Two children.", "suggested_scope": "shared"},
                 {"key": "family_copy", "content": "married to  ALEX.", "suggested_scope": "nova"}]
    [merged] = dedupe(proposals)
    assert merged["content"] == "Married to Alex.\n\nTwo children." and merged["suggested_scope"] == "nova"


def test_compare_marks_unchanged_updates_and_new_with_private_default():
    own = note("career.employer", "Works at Example AS.", NOVA, "Career & Work")
    shared_same_key = note("career.employer", "Old shared text.")
    infra = note("homelab.proxmox", "Three Proxmox nodes run the homelab cluster with Ceph storage.", None, "Homelab Infrastructure")
    proposals = [
        {"key": "anything", "content": "works at example as.", "suggested_scope": "nova", "updates_key": None, "section": 0},
        {"key": "career.employer", "content": "Works at Sample ASA since October.", "suggested_scope": "shared", "updates_key": None, "section": 0},
        {"key": "homelab.cluster", "content": "Three Proxmox nodes run the homelab cluster with Ceph storage and 10G networking.",
         "suggested_scope": "shared", "updates_key": None, "section": 1},
        {"key": "ai.gpu", "content": "An RTX 3080 laptop serves local models.", "suggested_scope": "shared", "updates_key": None, "section": 1},
    ]
    result = {p["key"]: p for p in compare(proposals, [own, shared_same_key, infra], NOVA)}
    assert result["anything"]["action"] == "unchanged" and result["anything"]["target"]["id"] == str(own.id)
    assert result["career.employer"]["action"] == "update" and result["career.employer"]["target"]["id"] == str(own.id)
    assert result["career.employer"]["scope"] == "nova" and result["career.employer"]["suggested_scope"] == "shared"
    assert result["homelab.cluster"]["action"] == "update" and result["homelab.cluster"]["reason"] == "similar text"
    assert result["homelab.cluster"]["scope"] == "shared"
    assert result["ai.gpu"]["action"] == "create" and result["ai.gpu"]["scope"] == "nova" and result["ai.gpu"]["suggested_scope"] == "shared"


def test_index_lists_the_most_related_notes_first():
    notes = [note(f"misc.{i}", f"Unrelated topic number {i}") for i in range(50)] + [note("homelab.proxmox", "Proxmox cluster with Ceph")]
    index = index_for("Our Proxmox cluster uses Ceph", notes, NOVA, limit=3)
    assert index.splitlines()[0].startswith("- homelab.proxmox [Uncategorized] (shared)") and len(index.splitlines()) == 3


def test_owner_note_rules_and_duplicate_pairs():
    assert note_problem("k", "x" * 8001) and note_problem("k", "fine", kind="maybe") and note_problem("claude.x", "fine")
    assert note_problem("claude.x", "fine", allow_reserved="claude.") is None
    a, b, c = note("a", "Runs three Proxmox nodes with Ceph"), note("b", "runs three proxmox nodes with ceph storage"), note("c", "Likes tea")
    assert similarity(a.content, b.content) > 0.6
    assert duplicate_pairs([a, b, c, note("claude.x", a.content)]) == [(a.id, b.id, round(similarity(a.content, b.content), 2))]
