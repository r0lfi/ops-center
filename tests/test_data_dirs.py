import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

def test_manual_data_directories_match_the_installer():
    play = yaml.safe_load((ROOT / 'deploy/install.yml').read_text())[0]
    task = next(t for t in play['tasks'] if t['name'] == 'Create runtime data directories')
    installer = {(i['path'], int(i['uid']), str(i.get('mode', '0750'))) for i in task['loop'] if i['path']}
    script = (ROOT / 'scripts/prepare-data-dirs.sh').read_text()
    listed = re.search(r'<<EOF\n(.*?)\nEOF', script, re.S).group(1)
    manual = {(p, int(u), m) for p, u, m in (line.split() for line in listed.splitlines())}
    assert manual == installer
