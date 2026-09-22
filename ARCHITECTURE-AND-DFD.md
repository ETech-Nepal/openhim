---
title: "OpenHIE Stack — System Architecture, Deployment & Data-Flow Diagrams"
subtitle: "Logical & deployment architecture, network/request flow, DFD levels 0/1/2, ERD"
date: 2026-08-28
---

# System Architecture, Deployment & Data-Flow Diagrams

All diagrams are derived from `docker-compose.yml`, the mediator source, the
`keycloak/` scripts and `jempi-config/`. Diagram-as-code (Mermaid) so they stay
maintainable.

Notation:

- **Architecture diagrams** — components, containers, protocols, ports.
- **DFD** — squared nodes = external entities, rounded = processes,
  `[( )]` = data stores, labelled arrows = data flows. DFD notation is kept
  separate from architecture notation.

---

## 1. Component summary

| Component | Image / source | Role | Host port(s) |
|---|---|---|---|
| OpenHIM Core | `jembi/openhim-core:latest` | client auth (Basic + Keycloak JWT), channel routing, transaction log | `8080` API, `5000` HTTPS tx, `127.0.0.1:5001` HTTP tx |
| OpenHIM Console | `organsushi/medisha-him:latest` | admin web UI | `9000` |
| MongoDB | `mongo:4.0` | OpenHIM datastore (clients, channels, transactions) | none |
| HAPI FHIR | `hapiproject/hapi:latest` | FHIR R4 clinical store + Tester UI | `127.0.0.1:8081` |
| HAPI Postgres | `postgres:16-alpine` | HAPI relational store (`hapi`) + `admin_review` DB | none |
| Keycloak | `quay.io/keycloak/keycloak:26.7.2` | RS256 JWT issuer, realm `openhie` | `127.0.0.1:8083` |
| `mediator` (FHIR MPI Orchestrator) | `./services/fhir-mediator`, Node 20 | Patient to JeMPI to HID to HAPI upsert; other resources pass-through | internal `:4000` |
| `fhir-intake-mediator` | `./services/fhir-intake-mediator` | `POST /ingest`: CDRS row to Bundle to orchestrator; FHIR pass-through | internal `:4003` |
| `admin-mediator` | `./services/admin-mediator` | duplicate review queue + merge in JeMPI **and** HAPI | internal `:4002` |
| `patient-portal-mediator` | `./services/patient-portal-mediator` | read-only patient-scoped aggregate over HAPI | internal `:4001` |
| Caddy (`caddy` / `caddy-ip`) | `caddy:2-alpine` | reverse proxy + automatic TLS, **VPS only**, profiles `vps` / `vps-ip` | `80`, `443` |
| JeMPI | **external** — `202.51.71.81`, `:50000` open / `:50001` Keycloak | master patient index: golden records, deterministic + probabilistic linking | none |

Not in this repo (referenced only): the admin duplicate-review **UI**
(`admin_portal`) and the **CDRS dump script** (`FHIR_mediator/`).

---

## 2. Logical architecture

```mermaid
flowchart TB
    subgraph clients["Client systems, outside this repo"]
      EMR["Hospital EMR"]
      DUMP["CDRS dump script"]
      BFF_A["Admin portal BFF"]
      BFF_P["Patient portal BFF"]
    end

    KC["Keycloak, realm openhie, RS256 JWT issuer"]

    subgraph him["Interoperability layer, trust boundary"]
      HIM["OpenHIM Core. JWT verify vs cached realm JWKS. sub to Client. channel routing. transaction log"]
      MONGO[("MongoDB. clients, channels, transactions")]
      HIM --- MONGO
    end

    subgraph meds["Mediators. Node Express. no host ports. trust OpenHIM only"]
      MED["mediator 4000. path fhir. Patient to JeMPI to HAPI"]
      INTAKE["fhir-intake-mediator 4003. path ingest. CDRS to Bundle"]
      ADMIN["admin-mediator 4002. path admin. dup review and merge"]
      PORTAL["patient-portal-mediator 4001. path patient-portal. read-only"]
      RDB[("admin_review Postgres")]
      ADMIN --- RDB
    end

    JEMPI["JeMPI, external VPS. golden records and interactions. 50000 open, 50001 Keycloak"]

    subgraph clin["Clinical store"]
      HAPI["HAPI FHIR R4. 8080, host 127.0.0.1 8081"]
      PGDB[("PostgreSQL 16. hapi")]
      HAPI --- PGDB
    end

    CADDY["Caddy, VPS only. TLS termination 443"]

    EMR -->|"1. client_credentials with private_key_jwt"| KC
    EMR -->|"2. Bearer JWT to POST fhir"| CADDY
    DUMP -->|"POST ingest"| CADDY
    BFF_A -->|"Basic to admin review"| CADDY
    BFF_P -->|"Basic plus X-Patient-Token to patient-portal"| CADDY
    CADDY --> HIM
    HIM -.->|"verify signature vs"| KC
    HIM -->|"plus X-OpenHIM-ClientID"| MED
    HIM --> INTAKE
    HIM --> ADMIN
    HIM --> PORTAL
    INTAKE -->|"HTTP 4000"| MED
    MED -->|"crRegister and crCandidates"| JEMPI
    ADMIN -->|"gidsAll, customSearch, relink"| JEMPI
    MED -->|"PUT and GET FHIR"| HAPI
    ADMIN -->|"reconcile FHIR"| HAPI
    PORTAL -->|"GET FHIR"| HAPI
```

### Boundaries

| Boundary | Enforced by |
|---|---|
| Internet vs stack | Caddy (VPS) + host firewall — only `80`/`443` public in `vps` mode |
| Client vs mediator | **OpenHIM only** — mediators have no auth of their own; no mediator publishes a host port |
| Auth verification | OpenHIM vs the realm JWKS (`authentication_jwt_jwksUri`) — RS256, keys cached in-process, refetched only on an unknown `kid` |
| Facility identity | OpenHIM-set `X-OpenHIM-ClientID` — not forgeable; equals the NHFR code |
| Patient scoping (portal) | `patient-portal-mediator` verifies the forwarded `X-Patient-Token` and pins to one golden UID |
| Identity plane vs clinical plane | mediator orchestration — JeMPI resolves *who*, HAPI stores *what*; reads never touch JeMPI |

### Protocols and ports

| Link | Protocol | Port |
|---|---|---|
| EMR to Keycloak | HTTPS (VPS) / HTTP (local) | 443 / 8083 |
| EMR to OpenHIM tx | HTTPS | 443 (Caddy to 5001) / 5000 (self-signed) |
| OpenHIM to mediator | HTTP | 4000/4001/4002/4003 (internal) |
| mediator to JeMPI | HTTP | 50000 (`10.8.0.1` via WireGuard, or public IP) |
| mediator to HAPI | HTTP | 8080 (`fhir:8080` internal) |
| mediator to OpenHIM API | HTTPS self-signed | 8080 |
| admin-mediator to Postgres | TCP | 5432 (`hapi-db` internal) |
| OpenHIM to Mongo | TCP | 27017 (internal) |

---

## 3. Deployment architecture (VPS)

```mermaid
flowchart TB
    subgraph host["VPS host, Ubuntu or Debian. Docker Compose project openhim"]
      subgraph net["Docker network openhim, bridge"]
        CADDY["caddy or caddy-ip. 80 and 443 on host"]
        HIM["openhim-core. 8080 and 5000 on host. 127.0.0.1 5001"]
        CONSOLE["openhim-console. 9000 on host"]
        MONGO["mongo-db. no host port"]
        KC["keycloak. 127.0.0.1 8083"]
        HAPI["fhir HAPI. 127.0.0.1 8081"]
        HDB["hapi-db Postgres 16. no host port"]
        MED["mediator. no host port"]
        INTAKE["fhir-intake-mediator. no host port"]
        ADMIN["admin-mediator. no host port"]
        PORTAL["patient-portal-mediator. no host port"]
      end
      VOLS[("volumes: mongo-data, hapi-db-data, keycloak-data, caddy-data, caddy-config")]
      WG["wg0 optional. WireGuard tunnel 10.8.0.0 24"]
    end

    JEMPI["JeMPI VPS 202.51.71.81. Dgraph, Postgres, Kafka, linker, api, web. 50000 and 50001"]
    LE["Let's Encrypt, ACME"]
    DNS["DNS: keycloak, openhim, api, console subdomains of DOMAIN"]

    CADDY --> HIM
    CADDY --> KC
    CADDY --> CONSOLE
    HIM --> MONGO
    HAPI --> HDB
    ADMIN --> HDB
    MED --> HAPI
    ADMIN --> HAPI
    PORTAL --> HAPI
    INTAKE --> MED
    MED --> WG --> JEMPI
    MED -.->|"or public IP"| JEMPI
    CADDY -.->|"ACME"| LE
    DNS -.->|"A records"| CADDY
    KC -.->|"mounts realm-export.json"| VOLS
```

Notes: single host, one Compose project (`name: openhim`); no orchestrator, no
replicas; every service `restart: unless-stopped`. Bind mounts:
`application.yaml` + `np.core-1.0.0.tgz` to
fhir; `realm-export.json` to keycloak; `jempi-config/` to admin-mediator
(read-only `/config`); each mediator's source dir to its container (`node
--watch` dev bind mount). Caddy is profile-gated.

---

## 4. Network / request flow — Patient write

```mermaid
sequenceDiagram
    autonumber
    participant EMR as Hospital EMR
    participant KC as Keycloak
    participant HIM as OpenHIM Core
    participant MED as mediator 4000
    participant JEMPI as JeMPI 50000
    participant HAPI as HAPI FHIR 8080

    EMR->>KC: client_credentials with private_key_jwt
    KC-->>EMR: RS256 access token, sub equals NHFR code
    EMR->>HIM: POST Patient with Bearer token
    HIM->>HIM: verify JWT vs cached realm JWKS, check iss and aud, map sub to Client, match the fhir channel, check role
    HIM->>MED: forward plus X-OpenHIM-ClientID NHFR
    MED->>MED: reuse a valid incoming HID, else generateHealthId plus Damm
    MED->>HAPI: GET Patient by identifier nepal-health-id candidate, uniqueness, up to 5 times
    MED->>JEMPI: POST crRegister with demographics and auxId equal to the HID
    JEMPI-->>MED: goldenUID, or 409 exists
    MED->>JEMPI: POST crCandidates to resolve the golden UID and stored auxId on a dup
    MED->>MED: stamp identifiers jempi-golden-uid and nepal-health-id, delete id, stamp meta.tag source-facility and jempi-interaction-uid
    MED->>HAPI: GET Patient by identifier nepal-health-id id, read-before-merge
    MED->>HAPI: PUT Patient by identifier nepal-health-id id, conditional upsert
    HAPI-->>MED: 200 or 201 Patient with an opaque server id
    MED-->>HIM: OpenHIM envelope plus orchestrations
    HIM-->>EMR: unwrapped FHIR Patient
```

---

## 5. DFD Level 0 — Context

```mermaid
flowchart LR
    EMR["Hospital EMR"]
    CDRS["CDRS dump script"]
    ADMINU["Data-quality admin"]
    PATIENT["Patient, via portal BFF"]
    KC["Keycloak IdP"]
    JEMPI["JeMPI MPI, external"]

    SYS(("OpenHIE Exchange. OpenHIM plus mediators plus HAPI"))

    EMR -->|"FHIR resource plus JWT"| SYS
    SYS -->|"persisted resource plus Health ID plus golden UID"| EMR
    CDRS -->|"raw CDRS encounter row plus JWT"| SYS
    SYS -->|"Bundle result"| CDRS
    ADMINU -->|"review, merge or dismiss decision"| SYS
    SYS -->|"duplicate queue plus scored evidence"| ADMINU
    PATIENT -->|"X-Patient-Token via BFF"| SYS
    SYS -->|"aggregate clinical summary, no ids"| PATIENT
    KC -->|"RS256 public key and tokens"| SYS
    SYS <-->|"crRegister, crCandidates, relink, customSearch"| JEMPI
```

---

## 6. DFD Level 1 — Major processes

```mermaid
flowchart TB
    EMR["Hospital EMR"]
    CDRS["CDRS dump script"]
    ADMINU["Admin"]
    PATIENT["Patient portal BFF"]
    KC["Keycloak"]
    JEMPI["JeMPI"]

    P1(("1.0 Authenticate and route. OpenHIM Core"))
    P2(("2.0 Convert intake. fhir-intake-mediator"))
    P3(("3.0 Resolve identity and persist. mediator"))
    P4(("4.0 Pass-through resource. mediator"))
    P5(("5.0 Duplicate review and merge. admin-mediator"))
    P6(("6.0 Patient summary. patient-portal-mediator"))

    DS1[("D1 OpenHIM Mongo. clients, channels, transactions")]
    DS2[("D2 HAPI Postgres. FHIR resources")]
    DS3[("D3 admin_review Postgres. review_tasks")]
    DS4[("D4 JeMPI Dgraph. golden records, interactions")]

    EMR -->|"JWT plus FHIR"| P1
    CDRS -->|"JWT plus raw row"| P1
    ADMINU -->|"JWT or Basic plus decision"| P1
    PATIENT -->|"Basic plus X-Patient-Token"| P1
    KC -->|"realm public key"| P1
    P1 -->|"transaction plus orchestrations"| DS1
    P1 -->|"raw row plus X-OpenHIM-ClientID"| P2
    P1 -->|"Patient write"| P3
    P1 -->|"other resource or GET"| P4
    P1 -->|"review request"| P5
    P1 -->|"summary request"| P6
    P2 -->|"GET Organization by nhfr identifier"| P4
    P2 -->|"Patient plus Encounter Bundle"| P3
    P3 <-->|"crRegister and crCandidates"| DS4
    P3 -->|"conditional PUT Patient or Bundle"| DS2
    P4 -->|"POST or GET FHIR"| DS2
    P5 <-->|"gidsAll, customSearch, expandedGolden, relink"| DS4
    P5 -->|"reconcile, move refs, retire loser"| DS2
    P5 <-->|"upsert, claim, resolve task"| DS3
    P5 -->|"queue plus evidence"| ADMINU
    P6 -->|"GET Patient by golden-uid identifier plus fan-out"| DS2
    P6 -->|"summary, no ids"| PATIENT
    P3 -->|"result"| EMR
```

---

## 7. DFD Level 2 — Patient registration (process 3.0)

```mermaid
flowchart TB
    IN["Patient write from OpenHIM plus X-OpenHIM-ClientID"]
    JEMPI["JeMPI"]
    DS2[("HAPI Postgres")]

    A(("3.1 pick candidate Health ID. reuse a valid incoming id, else generateHealthId plus Damm"))
    B(("3.2 uniqueness check. GET Patient by identifier nepal-health-id candidate, up to 5 times"))
    C(("3.3 JeMPI register. POST crRegister auxId equals candidate"))
    D(("3.4 resolve golden on dup. POST crCandidates"))
    E(("3.5 choose Health ID. reuse the JeMPI auxId if valid, else candidate"))
    F(("3.6 stamp identifiers. add jempi-golden-uid and nepal-health-id, delete id"))
    G(("3.7 resolve facility and stamp provenance. meta.tag source-facility and jempi-interaction-uid"))
    H(("3.8 read-before-merge. GET Patient by identifier nepal-health-id healthId"))
    I(("3.9 union prior facilities hospital-MRNs"))
    J(("3.10 conditional update. PUT Patient by identifier nepal-health-id healthId"))
    K["OpenHIM envelope plus orchestrations to caller"]
    ERR["502 OperationOutcome, no write"]

    IN --> A --> B --> C
    C -->|"golden UID"| E
    C -->|"exists or 409, no UID"| D --> E
    C -->|"no golden UID"| ERR
    E --> F --> G --> H
    B <--> DS2
    C <--> JEMPI
    D <--> JEMPI
    H <--> DS2
    H --> I --> J --> K
    J <--> DS2
```

---

## 8. DFD Level 2 — CDRS intake (process 2.0)

```mermaid
flowchart TB
    IN["POST ingest from OpenHIM. Content-Type plus X-OpenHIM-ClientID, the NHFR code"]
    P3["3.0 mediator, the orchestrator"]

    CT(("2.1 classify Content-Type. application json is raw. application fhir plus json is fhir. else 415"))
    G403(("2.2 require X-OpenHIM-ClientID. else 403"))
    V(("2.3 validate CDRS row with zod. required fields, sex enum, real dates, imis 9 digit. else 400"))
    ORG(("2.4 resolve facility. GET Organization by nhfr identifier equal to clientID. exactly one, else 422"))
    MAP(("2.5 map to a transaction Bundle. Patient imis to BIMA and hospno to hospital-mrn plus assigner. Encounter class C E N, plus 05 45 offset, ifNoneExist on encounter-number"))
    FV(("2.6 validate FHIR input. resourceType allowlist. Bundle type transaction or batch. else 400"))
    FWD(("2.7 forward to mediator 4000. unwrap the OpenHIM envelope, merge orchestrations"))
    OUT["one OpenHIM transaction to caller"]
    E415["415"]
    E422["422, nothing written"]

    IN --> CT
    CT -->|"fhir"| G403 --> FV --> FWD --> P3 --> OUT
    CT -->|"raw"| G403 --> V --> ORG --> MAP --> FWD
    CT -->|"other"| E415
    ORG -->|"zero or more than one"| E422
```

---

## 9. DFD Level 2 — Duplicate detection and merge (process 5.0)

```mermaid
flowchart TB
    ADMINU["Admin"]
    JEMPI["JeMPI"]
    DS2[("HAPI")]
    DS3[("admin_review")]

    S1(("5.1 GET gidsAll"))
    S2(("5.2 POST expandedGoldenRecords, page by SCAN_PAGE_SIZE"))
    S3(("5.3 POST customSearch golden, the or blocking rule"))
    S4(("5.4 scorePair. Fellegi-Sunter from jempi-config m over u. exact for dob, nid, phone. skip blanks and the placeholder phone"))
    S5(("5.5 gate. score is not null and discriminating and band is not below"))
    S6(("5.6 upsertTask. ON CONFLICT keeps DISMISSED and MERGED"))
    M1(("5.7 admin opens a task. scored evidence plus HAPI encounter counts"))
    M2(("5.8 claimOpenTask, conditional. two admins cannot both merge"))
    M3(("5.9 read survivor and loser Health IDs first"))
    M4(("5.10 JeMPI relink each loser interaction onto the survivor"))
    M5(("5.11 HAPI reconcile. move refs, copy foreign identifiers, set replaces and replaced-by, loser active false"))
    M6(("5.12 resolveTask MERGED or MERGE_PARTIAL or DISMISSED. purge stale OPEN tasks"))

    S1 --> S2 --> S3 --> S4 --> S5 --> S6
    S1 <--> JEMPI
    S2 <--> JEMPI
    S3 <--> JEMPI
    S6 --> DS3
    ADMINU --> M1 --> M2 --> M3 --> M4 --> M5 --> M6
    M2 <--> DS3
    M3 <--> JEMPI
    M4 <--> JEMPI
    M5 <--> DS2
    M6 --> DS3
```

---

## 10. DFD Level 2 — Patient search / portal summary (process 6.0)

```mermaid
flowchart TB
    BFF["Patient portal BFF"]
    DS2[("HAPI")]

    R0(("6.0 OpenHIM authenticates the portal system client. Basic, role patient-portal-clients"))
    R1(("6.1 patientContext verifies X-Patient-Token. RS256 JWKS or HS256 dev. yields goldenUid"))
    R2(("6.2 GET Patient by identifier jempi-golden-uid goldenUid, count 50"))
    R3(("6.3 per linked Patient, GET Encounter, DiagnosticReport, DocumentReference, Observation by subject"))
    R4(("6.4 resolve Organization display names"))
    R5(("6.5 shape encounters, reports, results. id-free, sorted. profile merged"))
    OUT["summary to BFF"]

    BFF --> R0 --> R1 --> R2 --> R3 --> R4 --> R5 --> OUT
    R2 <--> DS2
    R3 <--> DS2
    R4 <--> DS2
```

Also `GET /patient-portal/resolve?healthId=|phone=` (system-authed, no
`X-Patient-Token`): returns `{ goldenUid, phone, displayName }` for the BFF to
send an OTP — no clinical data.

---

## 11. Patient identity lifecycle (state)

```mermaid
stateDiagram-v2
    [*] --> Registered: first crRegister, new golden UID and new Health ID
    Registered --> Registered: re-register same demographics, same golden UID and Health ID, dedup
    Registered --> Updated: PUT Patient, conditional update on nepal-health-id, merged demographics and carried-forward MRNs
    Registered --> UnderReview: admin scan finds a near-miss duplicate, score at least REVIEW_LOW
    UnderReview --> Merged: admin says same person, JeMPI relink plus HAPI reconcile, losing golden deleted, losing Patient retired
    UnderReview --> Dismissed: admin says not the same person, never re-raised
    Merged --> MergePartial: JeMPI relinked but HAPI reconcile failed, retryable
    MergePartial --> Merged: retry, HAPI steps idempotent
    Merged --> [*]
```

No split operation exists; a wrong merge is effectively irreversible.

---

## 12. Database ERD

The only application-owned relational schema in this repo is
`admin_review.review_tasks` (`services/admin-mediator/src/db/pool.ts`). HAPI's ~150 tables
are managed by HAPI itself (Hibernate; Flyway disabled).

```mermaid
erDiagram
    review_tasks {
        uuid id PK
        text pair_key UK "canonical sorted goldenA and goldenB"
        text golden_a "JeMPI golden UID, logical, cross-store"
        text golden_b "JeMPI golden UID, logical, cross-store"
        numeric score "NUMERIC 6 4, normalised 0 to 1"
        text band "likely, possible, below"
        text status "OPEN, MERGED, DISMISSED, MERGE_PARTIAL"
        jsonb detail "scored field breakdown plus demographic snapshots a and b"
        jsonb resolution "survivor and loser, error, timestamp"
        text resolved_by "X-Admin-User forwarded by the BFF"
        timestamptz resolved_at
        timestamptz created_at
        timestamptz updated_at
    }
```

Indexes: `(status, score DESC)`, `(golden_a, golden_b)`. `golden_a` / `golden_b`
reference JeMPI golden records in a different datastore — no FK.

---

## 13. Trust boundaries

```mermaid
flowchart LR
    subgraph untrusted["Untrusted"]
      C["clients and internet"]
    end
    subgraph edge["Edge, VPS"]
      CADDY["Caddy TLS plus ufw, only 22, 80, 443"]
    end
    subgraph authz["Auth boundary"]
      HIM["OpenHIM. JWT verify offline, sub to Client, role and channel check, sets X-OpenHIM-ClientID"]
    end
    subgraph internal["Internal Docker network openhim, no host ports"]
      MEDS["mediators, trust OpenHIM only, no auth of their own"]
      HAPI["HAPI, no auth, loopback plus network isolation"]
      DBS["Postgres and Mongo, no host ports"]
    end
    subgraph external["External, HTTP over WireGuard or public IP"]
      JEMPI["JeMPI 50000, no auth"]
    end
    C --> CADDY --> HIM --> MEDS --> HAPI --> DBS
    MEDS --> JEMPI
```

`patient-portal-mediator` additionally verifies `X-Patient-Token` and pins each
request to one golden UID, so a correctly authenticated portal can still only
read the patient who logged in.

---

## 14. Written walk-through

A client obtains an RS256 JWT from Keycloak (hospitals via `private_key_jwt`
client-credentials; the demo user via password grant; the two BFFs via OpenHIM
Basic auth). It sends the JWT as `Authorization: Bearer` on every request to
OpenHIM Core's transaction port. OpenHIM verifies the signature against the
realm JWKS (cached; refetched on an unknown `kid`), checks `iss`/`aud`, maps the token `sub` to a
registered OpenHIM **Client**, matches the URL against a **channel**, checks the
Client's role against the channel's `allow` list, and forwards to the mediator on
the internal Docker network — injecting the non-forgeable `X-OpenHIM-ClientID`.

Each mediator owns one URL space:

- **`mediator`** (`/fhir`) — for a Patient write it resolves identity through
  JeMPI: mint or reuse the Damm-checked Nepal Health ID, obtain the golden UID
  from `crRegister` (resolving via `crCandidates` on a deterministic duplicate),
  stamp both identifiers plus `source-facility` / `jempi-interaction-uid`
  provenance, read-merge any existing HAPI record (carrying forward other
  facilities' MRNs), and do an idempotent conditional `PUT` keyed on the Health
  ID identifier. Other resources pass through with light enrichment
  (conditional-reference resolution, Practitioner identifier dedup,
  DocumentReference Binary upload). GET searches forward to HAPI unchanged and
  never call JeMPI.
- **`fhir-intake-mediator`** (`/ingest`) — converts one raw CDRS encounter row to
  a Patient+Encounter transaction Bundle (resolving the facility Organization by
  the trusted `X-OpenHIM-ClientID` NHFR code, requiring exactly one match), or
  passes supported FHIR JSON through, then forwards to `mediator:4000` and merges
  the downstream orchestrations into one OpenHIM transaction.
- **`admin-mediator`** (`/admin`) — scans JeMPI golden records for near-miss
  duplicates the deterministic write path never flags, scores them with
  Fellegi-Sunter weights read from the *deployed* JeMPI link config, queues them
  in its own Postgres DB, and on an admin decision merges a pair in JeMPI
  (`/relink`) then reconciles HAPI (repoint clinical records, carry foreign
  identifiers, retire the loser with `replaced-by`).
- **`patient-portal-mediator`** (`/patient-portal`) — read-only. After OpenHIM
  authenticates the portal BFF it independently verifies the forwarded
  per-patient `X-Patient-Token`, pins the request to that patient's golden UID,
  fans out across every linked HAPI Patient, and returns a merged, id-free
  summary.

Every mediator reply is an OpenHIM response envelope
(`application/json+openhim`), so OpenHIM logs every downstream call as an
orchestration and returns only the inner body to the client. The OpenHIM
transaction log is therefore both the audit record and the live flow diagram.
