#!/usr/bin/env python3
"""Create installation secrets once. Settings arrive on stdin, never credentials."""
import json
import os
import re
import secrets
import sys
from pathlib import Path

def create_env(path, options):
    values = {
        'POSTGRES_USER': 'opscenter', 'POSTGRES_DB': 'opscenter',
        **{k: secrets.token_hex(32) for k in ('POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'API_SECRET_KEY', 'GRAFANA_ADMIN_PASSWORD')},
        **options,
    }
    for key, value in values.items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or not re.fullmatch(r'[A-Za-z0-9_./:@-]+', str(value)):
            raise ValueError(f'Unsupported characters in {key}')
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print('Existing .env preserved')
        return False
    with os.fdopen(fd, 'w') as output:
        output.write(''.join(f'{k}={v}\n' for k, v in values.items()))
    print('Created .env with newly generated secrets')
    return True

if __name__ == '__main__':
    create_env(Path(sys.argv[1]), json.load(sys.stdin))
