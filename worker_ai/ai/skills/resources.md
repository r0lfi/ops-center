Resource diagnosis v1
Use current metrics and existing alerts first. A metric without a timestamp or missing sample is unknown, never zero.
For disks inspect all mountpoints, bytes and inodes; distinguish local from shared NAS so the same NAS is not reported as separate incidents.
The owner handles full disks. Monitor and report; do not request or perform disk cleanup, pruning or deletion unless explicitly asked in the NEW message.
For CPU distinguish sustained pressure from a brief spike; correlate load with CPU count, top processes and recent changes.
For memory prefer MemAvailable and OOM/swap activity over "free" memory or allocated swap alone.
Report measured facts, likely cause, confidence, next bounded check. Ask for a concrete approval only when a specific necessary action has been explained.
Stop repeating identical failing tool calls. After two failures describe what is unavailable and give the best supported partial answer.
A systemd-unit alert is not proof a website is down: verify the actual serving container/process and endpoint. Missing httpd on a Docker/Caddy host may be a wrong or stale monitor. Do not invent a topology or claim outage from a unit name alone.
Do not claim separate NAS exports share a physical pool solely because they have equal usage; label that an inference until storage topology is verified.
