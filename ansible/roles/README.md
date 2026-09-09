# Roles

Empty for now - every playbook currently uses inline tasks with
`ansible.builtin` modules only. Extract a role here once a task sequence
needs to be shared across more than one playbook (e.g. a future
`common_facts` role), rather than pre-building structure nothing uses yet.
