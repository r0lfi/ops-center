import pytest

from security.docker_control import STACKS_ROOT, InvalidStackName, _validate_stack_name


def test_valid_name_resolves_under_stacks_root():
    path = _validate_stack_name("my-stack_01")
    assert path.parent == STACKS_ROOT.resolve()
    assert path.name == "my-stack_01"


@pytest.mark.parametrize(
    "name",
    [
        "../escape",
        "../../etc",
        "/etc/passwd",
        "Has-Upper-Case",
        "has spaces",
        "",
        "a" * 64,  # over the 63-char cap
        "-leading-dash",
    ],
)
def test_invalid_names_rejected(name):
    with pytest.raises(InvalidStackName):
        _validate_stack_name(name)


def test_path_traversal_via_dotdot_segment_is_rejected():
    # Even a name that regex-matches but tries to climb out via a dotdot
    # component embedded oddly should never resolve outside STACKS_ROOT.
    with pytest.raises(InvalidStackName):
        _validate_stack_name("..")
