from unittest.mock import patch

from worker_ai.ai.tools.exec_tools import AI_EXECUTABLE_PLAYBOOKS, execute_run_ansible_job


def test_run_ansible_job_rejects_a_playbook_outside_the_allowlist():
    with patch("worker_ai.ai.tools.exec_tools.run_ansible_query") as run_query:
        result = execute_run_ansible_job({"hostname": "example-web-01", "playbook": "reboot.yml"})

    run_query.assert_not_called()
    assert result["available"] is False


def test_run_ansible_job_allows_an_allowlisted_playbook():
    with patch("worker_ai.ai.tools.exec_tools.run_ansible_query", return_value={"available": True}) as run_query:
        for playbook in AI_EXECUTABLE_PLAYBOOKS:
            execute_run_ansible_job({"hostname": "example-web-01", "playbook": playbook})

    assert run_query.call_count == len(AI_EXECUTABLE_PLAYBOOKS)
