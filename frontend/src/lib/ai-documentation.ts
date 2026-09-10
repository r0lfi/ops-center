export interface DocumentationSection {
  id: string;
  title: string;
  paragraphs: string[];
  columns?: string[];
  rows?: string[][];
  flow?: string[];
  sources: string[];
}

export const documentation: DocumentationSection[] = [
  {
    id: "plattform", title: "1. Plattformen i bunnen",
    paragraphs: [
      "Ops Center er et webbasert kontrollplan for serverinventar, tjenester, overvåking, logger, containere, patching, sikkerhetsdata og automatisering. AI-laget bruker disse datakildene og driftsfunksjonene gjennom definerte verktøy.",
      "Nettleseren viser React-grensesnittet. Caddy ruter forespørsler til statiske frontendfiler eller FastAPI. API-et leser og skriver PostgreSQL og legger langvarige oppgaver på Celery-køer i Redis. Egne arbeidere utfører AI-kjøringer, Ansible-jobber og sikkerhets-/containerarbeid."
    ],
    columns: ["Lag", "Teknologi og ansvar"],
    rows: [
      ["Web", "React 18, TypeScript, React Router 7, Vite 6 og Tailwind CSS 3. UI-komponenter bruker blant annet Radix. Ops Floor har også Three.js / React Three Fiber."],
      ["API", "Python, FastAPI, Pydantic, SQLAlchemy og Alembic. Ruter ligger i backend/app/api/routes; modeller ligger i backend/app/models."],
      ["Arbeidskø", "Celery 5.4 og Redis. Ordinær worker, scheduler, security-worker og AI-worker har ulike oppgaver og køer."],
      ["Lagring", "PostgreSQL for applikasjonsdata. Redis for kø/resultater og hendelsesformidling. Prometheus og Loki lagrer henholdsvis metrics og logger."],
      ["Pakking", "Docker Compose. Egne applikasjonsimages bygges fra prosjektets Dockerfiles; eksakte bibliotekversjoner ligger i requirements.txt og package-lock.json."]
    ],
    sources: ["compose.yml", "frontend/package.json", "backend/requirements.txt", "worker_ai/requirements.txt", "backend/app/main.py"]
  },
  {
    id: "agentmodell", title: "2. Hva en AI-agent faktisk er",
    paragraphs: [
      "En agent er en rad i ai_agents kombinert med den delte Python-funksjonen run_agent(). Linux, Monitoring og Coordinator har samme kjørelogikk. Forskjellene ligger i rollebeskrivelse, systemprompt, tillatte verktøy, modellleverandør og konfigurasjon.",
      "Agentlaget er egenutviklet Python med HTTPX-kall til modellleverandørene. AI-workerens avhengigheter inneholder ikke LangChain, CrewAI eller et eksternt agent-SDK. Språkmodellen kjører hos den valgte leverandøren; AI-worker håndterer kontekst, verktøykall, datalagring og kontrollflyt.",
      "Systemprompten beskriver oppgaven og arbeidsmåten. Et JSON-skjema beskriver hvert verktøys navn, argumenter og formål. Modellen kan foreslå verktøykall, mens Python-koden avgjør om de kan behandles. Et navn eller en rollebeskrivelse gir ikke i seg selv nye tekniske rettigheter."
    ],
    columns: ["Agentfelt", "Betydning"],
    rows: [
      ["slug, name, responsibility", "Identitet og beskrivelse av fagansvar."],
      ["system_prompt", "Instruksjoner som sendes til modellen sammen med minnepolicy og eventuell notatkontekst."],
      ["provider_id, model", "Kobling til ai_providers. Agentens model overstyrer leverandørens default_model når feltet er satt."],
      ["allowed_tools", "Liste over verktøynavn runtime tillater for denne agenten."],
      ["allowed_hosts, allowed_environments", "Avgrensninger brukt ved verktøykall med hostname. Tom liste betyr ingen avgrensning i det aktuelle feltet."],
      ["enabled, status, current_task", "Aktivering og synlig aktivitet. Status oppdateres under kjøring og brukes i dashboard og Ops Floor."],
      ["max_tool_calls", "Begrenser antall modellrunder i løkken. Én runde kan inneholde flere verktøykall."],
      ["autonomy_level, max_execution_seconds", "Lagrede konfigurasjonsfelt. Disse er ikke selvstendige håndhevede tillatelser eller en tidsfrist i den gjennomgåtte runtime-løkken."]
    ],
    sources: ["backend/app/models/ai.py", "worker_ai/ai/runtime.py", "worker_ai/requirements.txt"]
  },
  {
    id: "roller", title: "3. Coordinator og fagagentene",
    paragraphs: [
      "Prosjektets migreringer og driftsdokumentasjon beskriver ti agentroller. Tabellen er en leseguide til ansvarsområdene. Faktisk aktivering, prompt, modell og verktøyliste må leses på Agents-siden, fordi konfigurasjonen kan endres i databasen.",
      "Coordinator får delegeringsverktøyet når dispatch_to_agent finnes i allowed_tools. Runtime annonserer andre aktiverte agenter og kaller den valgte agentens run_agent() med en avgrenset deloppgave. Svaret sendes tilbake til Coordinator som verktøyresultat."
    ],
    columns: ["Rolle", "Fagområde"],
    rows: [
      ["Coordinator", "Fordeler delspørsmål og sammenfatter svar fra spesialister."],
      ["Linux", "Tjenester, disk, prosesser og Linux-feilsøking."],
      ["Containers", "Containerstatus, logger, nettverk og containeroperasjoner."],
      ["Network", "Nettverk og trafikkoversikt."],
      ["Monitoring", "Metrics, varsler og driftsobservasjoner."],
      ["Security", "Sikkerhetsfunn og sårbarhetsoversikt."],
      ["Patching", "Patchstatus og oppdateringsarbeid."],
      ["Automation", "Tilgjengelige playbooks og automatiseringsoppgaver."],
      ["Chat", "Samtale og brukerrettet assistanse."],
      ["General", "Bredere undersøkelser, blant annet web og kode der verktøy er tillatt."]
    ],
    sources: ["worker_ai/ai/runtime.py", "backend/migrations/versions/0021_ai_agents_layer.py", "backend/migrations/versions/0025_general_agent.py", "backend/migrations/versions/0026_five_more_agents.py", "backend/migrations/versions/0031_chat_agent.py"]
  },
  {
    id: "kjoring", title: "4. Fra melding til ferdig svar",
    paragraphs: [
      "API-et oppretter en AITask og sender oppgave-ID til worker_ai.tasks.run_agent_task på køen ai. Arbeideren låser oppgaveraden ved oppstart, kontrollerer queued-status og setter running. Tidligere relevant historikk settes sammen før runtime starter.",
      "Runtime bygger leverandør, velger modell og sender systemprompt, meldinger og tilgjengelige verktøyskjemaer. Modellen returnerer tekst eller verktøykall. Resultatene legges tilbake i meldingslisten, og modellen får en ny runde til den svarer eller budsjettet er brukt opp.",
      "Til slutt lagres svartekst, brukte agenter, verktøynavn og argumenter, datakilder og varighet. completed betyr at samtalekjøringen er avsluttet; en separat driftsforespørsel kan fortsatt vente på godkjenning."
    ],
    flow: ["Webchat / signert Talk-melding", "FastAPI → AITask i PostgreSQL", "Redis / Celery → AI-worker", "Historikk + notater + systemprompt", "Modell → kontrollert verktøy → resultat → modell", "Svar og aktivitet → database → brukergrensesnitt"],
    sources: ["backend/app/api/routes/ai.py", "worker_ai/tasks.py", "worker_ai/celery_app.py", "worker_ai/ai/runtime.py"]
  },
  {
    id: "modeller", title: "5. Modellleverandører og inferens",
    paragraphs: [
      "Et felles AIProvider-grensesnitt har chat() og tool_result_messages(). Hver adapter oversetter interne meldinger og verktøyskjemaer til leverandørens format og normaliserer svaret til ProviderResult med tekst, ToolCall-liste, stop_reason og tokenforbruk.",
      "Leverandør velges fra en databaserad via build_provider(). Deaktivering, manglende modell, URL eller hemmelighet gir en tilgjengelighetsfeil. Koden velger ikke automatisk en annen leverandør ved feil. API-nøkler hentes fra filer gjennom secret_path og skal ikke legges i systemprompt eller dokumentasjon.",
      "OpenAI-adapteren i denne kodeversjonen bruker max_completion_tokens og sender reasoning_effort=none når verktøy er med. Anthropic-adapteren bruker max_tokens. Begge har standard utbudsjett 4096 i chat()-signaturen. Ollama-adapteren videresender ikke max_tokens til API-et. Dette beskriver implementasjonen, ikke en garanti for støtte i alle fremtidige modeller."
    ],
    columns: ["Adapter", "Transport i koden"],
    rows: [
      ["OpenAI", "HTTPX POST til /v1/chat/completions; function tools og tool-meldinger; HTTP-timeout 60 sekunder."],
      ["Anthropic", "HTTPX POST til /v1/messages; input_schema og tool_use/tool_result-blokker; HTTP-timeout 60 sekunder."],
      ["Ollama", "HTTPX POST til konfigurert /api/chat med stream=false; HTTP-timeout 120 sekunder. Modellen kjører der Ollama-endepunktet er installert."]
    ],
    sources: ["worker_ai/ai/providers/base.py", "worker_ai/ai/providers/factory.py", "worker_ai/ai/providers/openai.py", "worker_ai/ai/providers/anthropic.py", "worker_ai/ai/providers/ollama.py", "worker_ai/secrets.py"]
  },
  {
    id: "delegering", title: "6. Delegering, samtidighet og grenser",
    paragraphs: [
      "Delegering skjer synkront og sekvensielt inne i samme Celery-oppgave. Coordinator venter mens fagagenten kjører. MAX_DELEGATION_DEPTH=2 tillater dybde 0, 1 og 2; forsøk på dypere rekursjon stoppes. En prompt som ber om parallelt arbeid oppretter ikke parallell kjøring.",
      "AI-workerens Dockerfile starter Celery med concurrency=4. Dermed kan ulike køoppgaver behandles samtidig, selv om deloppgaver i én agentkjøring er sekvensielle. Prefetch er 1, task_acks_late er aktivert, og den globale Celery-grensen er 1200 sekunder.",
      "max_tool_calls brukes som antall modellrunder med minst én runde. max_execution_seconds finnes i modellen, men den gjennomgåtte runtime og oppgavefunksjonen sjekker ikke dette feltet. Man bør derfor ikke tolke agentens viste sekunder som en håndhevet tidsfrist.",
      "Stopp sjekkes mellom modell- og verktøysteg. Det er ikke en umiddelbar avbrytelse av en allerede pågående ekstern operasjon. En hard worker-timeout kan kreve kontroll av både oppgave- og jobbstatus etterpå."
    ],
    sources: ["worker_ai/ai/runtime.py", "worker_ai/celery_app.py", "worker_ai/Dockerfile", "worker_ai/tasks.py", "backend/app/api/routes/ai.py"]
  },
  {
    id: "verktoy", title: "7. Verktøy og datakilder",
    paragraphs: [
      "TOOL_SCHEMAS beskriver funksjonene som modellen kan be om. TOOL_REGISTRY inneholder direkte lesefunksjoner. Godkjenningspliktige funksjoner finnes som skjemaer, men utføres gjennom en separat executor etter godkjenning. allowed_tools kontrolleres i runtime før vanlige verktøy behandles.",
      "Modellens argumenter er JSON. Skjemaene veileder modellen; faktisk validering og avgrensning ligger i runtime og den enkelte verktøyfunksjonen. Verktøyresultater er data som sendes tilbake til modellen."
    ],
    columns: ["Verktøy / gruppe", "Datakilde og kjørevei"],
    rows: [
      ["get_server_metrics / get_alerts / search_logs", "Prometheus / Alertmanager / Loki."],
      ["get_service_status / get_disk_usage / get_running_processes", "Ansible-jobber via ordinær worker og SSH til administrert vert."],
      ["get_patch_status / list_pending_patches", "Lagrede patchdata i Ops Center-databasen."],
      ["get_security_summary / list_top_vulnerabilities", "Lagrede sikkerhetsfunn og sårbarhetsdata."],
      ["list_containers / get_container_vulnerabilities", "Containerinventar og skanningsdata i databasen."],
      ["get_container_logs / get_container_env_keys / list_docker_networks", "Docker via security-worker lokalt, eller Ansible på andre administrerte verter."],
      ["get_network_traffic_summary", "Traffic Map-data."],
      ["list_available_playbooks", "Registrerte playbooks i Ops Center."],
      ["web_fetch / web_search", "Web-innhenting og søk gjennom prosjektets web-verktøy."],
      ["list_repo_files / read_repo_file / search_code", "Kodeinnsyn gjennom prosjektets avgrensede kodeverktøy."],
      ["recall_memory / remember_fact", "Personlig minne, bare når runtime finner gyldig minneeier og aktivert minne."]
    ],
    sources: ["worker_ai/ai/tools/__init__.py", "worker_ai/ai/tools/", "worker_ai/ansible_ops.py", "worker_ai/docker_ops.py"]
  },
  {
    id: "godkjenning", title: "8. Godkjenning og reell utførelse",
    paragraphs: [
      "Når modellen ber om et utførelsesverktøy, oppretter request_approval() en AIAction med argumenter, risiko, nivå, ACT-kode og 15 minutters godkjenningsfrist. Handlingen kjøres ikke i agentløkken. En identisk forespørsel som fortsatt er pending eller approved innen fristen kan gjenbrukes.",
      "Approve-endepunktet kontrollerer rolle, nivå, status og utløp og legger execute_action_task på ai-køen. Arbeideren kontrollerer approved-status på nytt og avviser utførelse når tilknyttet oppgave er cancelled. Executor lagrer resultat og executed eller failed. approved betyr autorisert og kølagt, ikke ferdig.",
      "Et «ja» i webchat eller Talk er ikke koblet til godkjenning. Bruk Approvals og kontroller mål, argumenter og ACT-kode. autonomy_level omgår ikke denne flyten. Fristen kontrolleres ved godkjenning; executor har ikke en ny expires_at-sjekk i denne kodeversjonen."
    ],
    columns: ["Verktøy", "Nivå / minste rolle"],
    rows: [
      ["restart_service, run_ansible_job, container_action, scan_host", "2 / operator (admin kan også godkjenne)."],
      ["reboot_host, run_shell_command, container_exec", "3 / admin. Shell og container-exec krever godkjenning uansett kommandoinnhold."],
      ["run_ansible_job", "AI-verktøyets playbookvalg er patch-security.yml eller patch-all.yml."],
      ["container_action", "Avgrensede handlinger: start, stop eller restart."]
    ],
    sources: ["worker_ai/ai/actions.py", "worker_ai/ai/tools/exec_tools.py", "backend/app/api/routes/ai.py", "worker_ai/tasks.py"]
  },
  {
    id: "minne", title: "9. Historikk, langtidsminne og kontekst",
    paragraphs: [
      "Historikk og notater lagres i PostgreSQL. Det finnes ingen ekstern vektordatabase eller embedding-tjeneste i denne minneløsningen. ai_tasks er samtalearkivet; ai_memories inneholder notater; ai_memory_preferences styrer om brukeren tillater langtidsminne.",
      "Automatisk historikk omfatter inntil seks tidligere fullførte utvekslinger med samme agent, med inntil 2000 tegn fra input og 3000 tegn fra svar, samt handlingsutfall. Inntil tolv nylige personlige notater tas med, med inntil 600 tegn per notat. recall_memory kan hente inntil fire historiske utvekslinger og åtte notater.",
      "Notater kan være felles eller knyttet til en agents uforanderlige ID. Fagagenten får fellesnotater og egne notater, også ved delegering. Runtime bestemmer bruker og agent-ID; modellen får ikke velge en annen minneeier i argumentene. remember_fact lagrer eksplisitte fakta eller preferanser, uten en separat modellrunde som automatisk trekker ut notater.",
      "Avslått langtidsminne bevarer lagrede data, men skjuler personlige minneverktøy og notater i nye forespørsler og begrenser automatisk historikk til samme samtalenøkkel. Ny samtale sletter ingen data. Sletting av et notat fjerner ikke originalmeldinger, audit eller sikkerhetskopier.",
      "Agentscope avgrenser direkte notatoppslag, men er ikke en full konfidensialitetsgrense mellom brukerens agenter: historikk kan søkes på tvers av agenter, og delegerte svar kan formidle relevant informasjon. Valgte utdrag sendes til konfigurert modellleverandør. Lokal lagring betyr derfor ikke nødvendigvis lokal modellbehandling."
    ],
    sources: ["worker_ai/ai/memory.py", "worker_ai/tasks.py", "backend/app/api/routes/ai_memory.py", "backend/app/models/ai_memory.py", "README.md"]
  },
  {
    id: "talk", title: "10. Nextcloud Talk-integrasjonen",
    paragraphs: [
      "Nextcloud sender meldinger til /api/integrations/talk/webhook. API-et verifiserer HMAC-signaturen før meldingen blir en oppgave. run_talk_task kjører agentoppgaven og håndterer svar til Talk. Nextclouds egen lagring er separat fra Ops Centers PostgreSQL.",
      "Personlig minne krever en eksplisitt TALK_MEMORY_BINDINGS-kobling mellom signert users/<id>, godkjent romtoken og uforanderlig Ops Center-bruker-ID. Visningsnavn gir ikke tilgang. Arbeideren kontrollerer koblingen og aktiv konto igjen før personlig minne blir tilgjengelig.",
      "Talk-historikk avgrenses til rom og eier. Gamle meldinger uten eierskap blir ikke tildelt en bruker ut fra navnet. Romkoblingen overvåker ikke senere deltakerendringer; en kobling til personlig minne må revurderes før andre får tilgang til rommet. Godkjenning av driftsoperasjoner skjer fortsatt gjennom Ops Centers godkjenningsfunksjon."
    ],
    sources: ["backend/app/api/routes/integrations.py", "backend/app/core/talk_memory.py", "worker_ai/tasks.py", "README.md", "README.md"]
  },
  {
    id: "datamodell", title: "11. Datamodell og sporbarhet",
    paragraphs: [
      "SQLAlchemy-modellene definerer applikasjonens persistente tilstand, og Alembic-migreringer versjonerer databasestrukturen. Agentkonfigurasjon og historikk er data i databasen, ikke filer som blir sikret av en Git-commit alene.",
      "Tokenforbruk registreres per modellrunde når leverandøren rapporterer forbruk, og committes med en gang. Manglende forbrukstall betyr ikke nødvendigvis gratis kjøring. Eventuelle kostnadsestimater i API-et er beregnede anslag, ikke leverandørens faktura."
    ],
    columns: ["Tabell", "Innhold"],
    rows: [
      ["ai_providers", "Type, URL, standardmodell, aktivering og referanse til hemmelighetsfil."],
      ["ai_agents", "Rolle, prompt, verktøytilganger, leverandørkobling og aktivitet."],
      ["ai_tasks", "Input, svar, eier, samtalenøkkel, kilde, status, tidsbruk og brukte agenter/verktøy/datakilder."],
      ["ai_actions", "Godkjenningsforespørsel, mål, argumenter, beslutning, frist og utførelsesresultat."],
      ["ai_usage", "Modell, agent, oppgave og rapporterte input-/outputtokens."],
      ["ai_findings", "Struktur for agentfunn; tilstedeværelsen av tabellen betyr ikke at alle chatsvar lager et funn."],
      ["ai_memories / ai_memory_preferences", "Personlige felles- og agentnotater samt brukerens minnepreferanse."]
    ],
    sources: ["backend/app/models/ai.py", "backend/app/models/ai_memory.py", "backend/migrations/versions/", "worker_ai/ai/runtime.py", "backend/app/api/routes/ai.py"]
  },
  {
    id: "live", title: "12. Dashboard, Ops Floor og status",
    paragraphs: [
      "set_agent_state() skriver først agentens status og aktivitet til PostgreSQL og publiserer deretter en Redis-hendelse. API-et formidler aktivitet gjennom /api/ai/agents/stream, som brukes av frontendens aktivitetsfeed. Databasen er autoritativ dersom hendelsesstrømmen mister en oppdatering.",
      "Samme statusfunksjon brukes av direkte og delegerte agenter. Derfor kan Ops Floor vise at Coordinator venter mens en fagagent undersøker. Visualiseringen er et grensesnitt over denne tilstanden; agentfigurene er ikke separate prosesser.",
      "Skil mellom agentstatus, samtaleoppgave og driftsforespørsel. En agent kan være idle etter å ha svart at godkjenning trengs, samtidig som AIAction fortsatt er pending. Enkelte håndterte leverandørfeil returneres som svartekst, slik at oppgaven kan stå completed mens agenten har error. Les derfor svar og handlingsresultat i tillegg til statusmerket."
    ],
    sources: ["worker_ai/ai/agent_state.py", "worker_ai/events.py", "worker_ai/tasks.py", "backend/app/api/routes/ai.py", "frontend/src/lib/useAgentActivityFeed.ts", "frontend/src/components/ops-floor/"]
  },
  {
    id: "driftsfunksjoner", title: "13. Serverdrift, containere og overvåking",
    paragraphs: [
      "Inventar og drifts-API knytter administrerte verter til jobber, patchstatus og sikkerhetsfunn. AI-verktøyene henter disse opplysningene eller bestiller arbeid gjennom samme underliggende kø- og jobbstruktur.",
      "run_ansible_query() oppretter AnsibleJob, sender worker.tasks.run_playbook og venter på terminal status i databasen. Hjelperen venter inntil 45 sekunder. Timeout kan bety at jobben fortsetter; den er ikke en bekreftelse på at fjernoperasjonen er stoppet.",
      "Docker-kall på workerens lokale vert sendes til security.<vertsnavn>, slik at riktig security-worker bruker riktig Docker-socket. På andre administrerte verter går kallene gjennom Ansible over SSH. AI-worker utfører ikke disse operasjonene ved å gi modellen en direkte Docker-socket.",
      "Prometheus samler metrics, Alertmanager håndterer varsler, Loki lagrer logger, og Grafana viser dashboards. Trivy og sikkerhetsarbeideren leverer skanning og sikkerhetsdata. Data fra databasen kan være eldre enn nåsituasjonen; kontroller innsamlingstid og den konkrete jobben før du tolker et agentsvar som fersk måling."
    ],
    sources: ["worker_ai/ansible_ops.py", "worker_ai/docker_ops.py", "worker/tasks.py", "security/", "monitoring/", "backend/app/api/routes/", "compose.yml"]
  },
  {
    id: "tilgang", title: "14. Tilgangskontroll og hemmeligheter",
    paragraphs: [
      "Ops Center har rollene viewer, operator og admin. Backend bruker rollekrav på endepunktene; frontendens skjulte knapper er ikke selve tilgangskontrollen. Autentisering bruker signerte JWT-er, og passord hashes med Argon2.",
      "For vanlige verktøykall kontrollerer runtime allowed_tools og eventuelle hostname-begrensninger. Miljøkontrollen slår opp vertsnavnet i inventaret. Disse sjekkene er knyttet til verktøykall med hostname og utgjør ikke en generell filtrering av alle datakilder. Delegerte agenter bruker sin egen konfigurasjon, ikke automatisk Coordinatorens vertsavgrensning.",
      "API-nøkler og SSH-hemmeligheter skal lagres utenfor Git; databasen kan inneholde filreferanser. Prompt, logger, verktøyresultater og minne må behandles som innhold som kan sendes til modellleverandøren. Et notat eller en logglinje kan ikke gi teknisk godkjenning til en driftsoperasjon.",
      "Shell- og container-exec-verktøy kan be om generell kommandoeksekvering, men krever admin-godkjenning. Dokumentasjonen skal derfor ikke tolkes som at alle tilgjengelige verktøy er ufarlige lesekall."
    ],
    sources: ["backend/app/services/auth.py", "backend/app/api/routes/ai.py", "worker_ai/ai/runtime.py", "worker_ai/ai/tools/shell_tools.py", "worker_ai/ai/tools/exec_tools.py", "worker_ai/secrets.py"]
  },
  {
    id: "ha", title: "15. Infrastruktur, HA og varige data",
    paragraphs: [
      "Prosjektet har Compose-oppsett for applikasjoner, PostgreSQL/Patroni med etcd, Redis/Sentinel og en witness. Sentinel brukes til å finne Redis-lederen. HA-oppsett og en fungerende failover er ulike ting; faktisk leder og tjenester må kontrolleres i driftsmiljøet.",
      "Varige data lagres lokalt under konfigurert DATA_ROOT. HA-generatoren oppretter separate databasevolumer. PostgreSQL, Redis, overvåkingsdata, Ansible-resultater, hemmeligheter og sikkerhetskopier har egne lagringsbehov. Git-synkronisering kopierer ikke brukere, samtaler, agentnotater eller databaseinnhold.",
      "Backup og gjenoppretting må omfatte database og relevante datavolumer samt sikker håndtering av hemmeligheter. Ved minneskjema 0034 må en gammel worker som ikke forstår agentscope ikke tas i bruk mot eksisterende agentnotater, fordi den kan behandle dem som fellesnotater."
    ],
    sources: ["compose.yml", "scripts/ha/generate.py", "docs/ha.md", "README.md"]
  },
  {
    id: "feilsoking", title: "16. Praktisk feilsøking",
    paragraphs: ["Følg oppgave-ID, eventuell ACT-kode og Ansible-jobb-ID gjennom de ulike lagene. Et språkmodellsvar alene bekrefter ikke at en tjeneste har endret tilstand."],
    columns: ["Symptom", "Hva du kontrollerer"],
    rows: [
      ["Oppgaven blir stående queued", "AI-workerens status og logger, ai-køen, Redis/Sentinel og at arbeideren bruker samme database og broker som API-et."],
      ["AI provider unavailable", "Aktivert leverandør, modellnavn, URL, lesbar secret_path, nettverk og feilsvaret fra leverandøren. Ikke skriv nøkkelen til logg."],
      ["Agent svarer uten ferske data", "tools_used og data_sources, tillatte verktøy, tilgjengelig datakilde og innsamlingstid. Modelltekst kan være en forklaring uten et verktøyoppslag."],
      ["Restart skjer ikke", "Finn ACT-koden i Approvals. Kontroller frist, rolle, beslutning, køstatus, executed/failed og underliggende jobb. Et chat-svar med «godkjent» utfører ikke godkjenning."],
      ["Ansible/Docker-verktøy får timeout", "Åpne Jobs og kontroller videre kjøring. Sjekk ordinær worker, vertsbestemt security-kø, SSH og vertens tilstand før du eventuelt gjentar handlingen."],
      ["Minne mangler", "Kontroller minnepreferanse, eier, valgt agent og felles-/agentscope. For Talk: eksakt bruker-/romkobling og aktiv konto. Automatisk kontekst har antalls- og tegnbegrensninger."],
      ["Ops Floor viser gammel aktivitet", "Sammenlign database-/oppgavestatus med agentstrøm, Redis-publisering og nettleserforbindelse."],
      ["Undersøkelsen stopper tidlig", "Kontroller antall modellrunder, leverandørens utbudsjett, delegeringsdybde og worker-timeout."
      ]
    ],
    sources: ["worker_ai/tasks.py", "worker_ai/ai/runtime.py", "worker_ai/ansible_ops.py", "worker_ai/docker_ops.py", "README.md"]
  },
  {
    id: "videreutvikling", title: "17. Bygg, vedlikehold og utvidelse",
    paragraphs: [
      "Frontend bygges fra frontend/ med npm ci og npm run build; byggeskriptet kjører TypeScript og Vite. Python-avhengigheter er låst i komponentenes requirements.txt. Compose og Dockerfiles beskriver hvilke filer og avhengigheter som pakkes i hver tjeneste.",
      "En ny fagrolle som bruker eksisterende verktøy kan bygges med en ny agentkonfigurasjon: navn, prompt, leverandør og eksplisitte verktøytilganger. Et nytt verktøy krever Python-implementasjon, argumentvalidering og skjema/registrering. Operasjoner som skal kreve godkjenning må gå gjennom AIAction og executor i stedet for det direkte leseregisteret.",
      "En ny modellleverandør implementerer AIProvider-kontrakten og kobles inn i factory.py. Verifiser oversettelse av meldinger og verktøyresultater, feiltilfeller, stop_reason og tokenregistrering. Endringer i persistente modeller må ha en gjennomtenkt Alembic-migrering.",
      "worker_ai/tests inneholder eksisterende tester for agenttilstand og øvrig AI-funksjonalitet. Ved endringer i runtime er særlig verktøyavvisning, godkjenningskrav, minneeierskap, delegering, kansellering og leverandørfeil relevante å kontrollere. Frontendendringer må bygges og sjekkes i nettleser.",
      "Ved utrulling bør kodeversjon og image-ID registreres, aktive oppgaver tas hensyn til, og begge frontendnoder bruke samme versjon. Denne dokumentasjonen oppdateres i frontend/src/lib/ai-documentation.ts; side og navigasjon er i AIDocumentation.tsx, App.tsx og Sidebar.tsx. Kontroller de oppgitte kodefilene når atferden endres."
    ],
    sources: ["frontend/package.json", "worker_ai/Dockerfile", "worker_ai/tests/", "worker_ai/ai/providers/base.py", "worker_ai/ai/tools/__init__.py", "docs/ha.md", "frontend/src/lib/ai-documentation.ts"]
  }
];
