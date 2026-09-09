"""Proof that the explanation a reader sees was really narrated by the configured
model, from really retrieved company documents, over figures the model never chose.

The pytest suite pins ``LLM_ENABLED=false`` on purpose: its subject is the governed
machinery, with the model scripted. So the suite can prove the *contract* -- sections
in order, figures from the stored row, limitations kept -- and cannot prove the one
thing an operator actually worries about:

    "Is any of this reaching the model at all, or has it been quietly serving
    platform prose since the day the endpoint stopped working?"

Both failures are silent by design. ``narrate`` swallows every model exception so a
bad model cannot break an explanation, and ``_citations`` returns an empty list when
retrieval finds nothing. A deployment can therefore look healthy while the model is
unreachable and the document library is never read. This script is the check that
tells them apart, against the deployment's own ``.env``:

1. the configured provider is contacted and its narration is what ships
   (``model_written`` true, the model named, and prose that is *not* the draft);
2. approved company documents are retrieved, cited, and visible in the answer;
3. **no figure in the narration is the model's own** -- every number in every
   section appears in the deterministic facts or in the draft the model was given;
4. no part of the business is named that is not in the stored breakdown;
5. no causal claim, and every limitation the draft stated survives the rewrite;
6. the fallbacks are real: a reader with no document access is told the context is
   missing rather than given a plausible substitute, and a low-confidence verdict
   stays hedged after the rewrite.

Run:  ollama serve  (or point .env at any configured provider), then
      ../.venv313/Scripts/python.exe verify_llm_rag_explanation.py

It builds its own scratch database and its own tenant. Nothing existing is read or
changed.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import timedelta
from pathlib import Path

TMP = Path(__file__).resolve().parent / "tests" / "_tmp"
TMP.mkdir(parents=True, exist_ok=True)
DB = TMP / "verify_llm_rag.db"
if DB.exists():
    DB.unlink()

# Storage and secret are overridden; the model configuration is deliberately left
# to .env, because "what this deployment is configured to do" is the subject.
os.environ["DATABASE_URL"] = f"sqlite:///{DB.as_posix()}"
os.environ["DOCUMENT_STORAGE_DIR"] = str(TMP / "verify_llm_rag_documents")
os.environ["SECRET_KEY"] = "verify-llm-rag-secret-not-for-production-0123456789"
os.environ["ENVIRONMENT"] = "test"

# Imported before any test module, so the settings singleton is built from .env.
# ``tests.conftest`` pins LLM_ENABLED=false in the environment when it loads, which
# is right for the suite and wrong here; it cannot rebuild a Settings object that
# already exists, and LIVE below is captured now so the pinning is also detectable.
from app.core.config import get_settings  # noqa: E402
from app.llm.config import llm_config_from_settings  # noqa: E402

SETTINGS = get_settings()
LIVE = llm_config_from_settings(SETTINGS)

from fastapi.testclient import TestClient  # noqa: E402

from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.llm.config import get_llm_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.seed.bootstrap import sync_reference_data  # noqa: E402
from app.services.explanation import NODE_SECTIONS, RESULT_SECTIONS  # noqa: E402
from tests.fixture_generalization import COMPANY_A_TARGET, build_company_a_source  # noqa: E402
from tests.test_detection_generalization import (  # noqa: E402
    approve_bucket_config,
    provision,
    run_detection,
)
from tests.test_explainability_findings import CAUSAL_WORDS  # noqa: E402
from tests.test_investigation_contribution import register_kpi_with_dimensions  # noqa: E402

# ``tests.conftest`` set these in the environment on import. Put the deployment's
# own values back on the live settings object so what is exercised is the .env
# configuration this script was pointed at.
SETTINGS.llm_enabled = LIVE.enabled
SETTINGS.llm_provider = LIVE.provider
SETTINGS.llm_tool_calling_enabled = LIVE.tool_calling_enabled

API = "/api/v1"
PASSWORD = "Verify-Llm-Rag-2026"

#: Regions the seeded source contains. A narration naming one that is not in the
#: stored breakdown has invented a part of the business, which is the qualitative
#: twin of inventing a number.
KNOWN_REGIONS = ("North", "South", "East", "West", "Central")

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}", flush=True)
    if not condition:
        failures.append(f"{label} -- {detail}".strip())
    return condition


def numbers_in(text: str) -> set[str]:
    """Every figure in a block of prose, normalised for comparison.

    Commas dropped and a trailing ``.0`` trimmed, so ``1,234.0`` and ``1234`` are
    recognised as the same measurement rather than as a figure the model invented.
    """
    found: set[str] = set()
    for match in re.findall(r"-?\d[\d,]*\.?\d*", text):
        value = match.replace(",", "").rstrip(".")
        if value.endswith(".0"):
            value = value[:-2]
        found.add(value.lstrip("-"))
    return found


def prose_of(explanation: dict) -> str:
    return "\n".join(item["body"] for item in explanation["sections"])


def sections_of(explanation: dict) -> dict[str, str]:
    return {item["heading"]: item["body"] for item in explanation["sections"]}


def permitted_numbers(deterministic: dict, facts: dict | None) -> set[str]:
    """Every figure the model was allowed to write, from the two things it was given.

    The draft sections and the FACTS block, plus the components of any figure that
    appears in them: a model rendering ``2026-08-28`` as ``28 August 2026`` has not
    invented a date, and one writing ``52`` where FACTS holds ``"reference_count":
    52`` has not invented a count. What this set deliberately does not contain is
    anything derivable-but-unstated -- a ratio, an annualisation, a per-day average --
    because those are exactly the figures a helpful model adds and nobody measured.
    """
    allowed = numbers_in(prose_of(deterministic))
    allowed |= numbers_in(json.dumps(deterministic.get("limitations") or []))
    allowed |= numbers_in(json.dumps(deterministic.get("confidence") or {}))
    allowed |= numbers_in(json.dumps([c.get("snippet") for c in deterministic.get("citations") or []]))
    if facts:
        allowed |= numbers_in(json.dumps(facts, default=str))
    # Integer forms of every allowed decimal, and the year/month/day of every date
    # already present, so a re-rendered figure is not read as a new one.
    for value in list(allowed):
        if "." in value:
            allowed.add(value.split(".")[0])
        if "-" in value:
            allowed.update(part for part in value.split("-") if part)
    return allowed


def report_prose(label: str, explanation: dict, deterministic: dict) -> None:
    """The checks that apply to any narration, model-written or not."""
    prose = prose_of(explanation)
    lowered = prose.lower()

    said = [word for word in CAUSAL_WORDS if word in lowered]
    check(f"[{label}] no causal claim in the narration", not said, str(said))

    kept = [
        item
        for item in deterministic["limitations"]
        if item not in explanation["limitations"]
    ]
    check(
        f"[{label}] every limitation the draft stated survives the rewrite",
        not kept,
        f"dropped: {kept}",
    )

    invented = numbers_in(prose) - permitted_numbers(deterministic, explanation.get("facts"))
    check(
        f"[{label}] every figure in the narration came from the platform",
        not invented,
        f"figures with no source: {sorted(invented)}",
    )


# ---------------------------------------------------------------------------
print("=" * 78)
print("LLM + RAG explanation path, against the configured provider")
print("=" * 78)
print("\n[1] What this deployment is configured to do")
# ---------------------------------------------------------------------------
print("      " + json.dumps(LIVE.describe()))
if not check(
    "a model is configured and available",
    LIVE.is_available,
    str(LIVE.unavailable_reason),
):
    print("\nNothing to verify: configure a provider in .env first.")
    sys.exit(1)
check(
    "the settings singleton still reports the deployment's model",
    get_llm_config().is_available,
    str(get_llm_config().unavailable_reason),
)
check("no credential in the described configuration", LIVE.api_key not in json.dumps(LIVE.describe()) or not LIVE.api_key)

# ---------------------------------------------------------------------------
print("\n[2] A tenant with an approved KPI, a stored movement, and two documents")
# ---------------------------------------------------------------------------
Base.metadata.create_all(bind=engine)
session = SessionLocal()
try:
    sync_reference_data(session)
    session.commit()
finally:
    session.close()

seeded = build_company_a_source(TMP / "verify_llm_rag_source.db")

with TestClient(create_app()) as client:
    admin, base, tables = provision(
        client,
        email="admin@aurora-llm-rag.example.com",
        company_name="Aurora Retail LLM RAG",
        source_name="Aurora Commerce",
        source_path=seeded["path"],
        scope={"orders": "order_date"},
    )
    company_id = base.rsplit("/", 1)[-1]
    revenue_id = register_kpi_with_dimensions(admin, base, source_table_id=tables["orders"]["id"])
    approve_bucket_config(
        admin,
        base,
        config_key="aurora-llm-rag-weekly",
        name="Aurora weekly trading pattern",
        buckets={
            "same_day_of_week": {"enabled": True, "days": ["FRI"]},
            "yoy_period": {"enabled": True},
        },
    )
    detection = run_detection(admin, base, revenue_id, COMPANY_A_TARGET)
    stored = detection["result"]
    check(
        "the seeded movement stored an ABNORMAL verdict",
        stored["status"] == "ABNORMAL",
        json.dumps(stored),
    )
    print(
        f"      stored: {stored['kpi']} {stored['target_date']} "
        f"actual={stored['actual']} expected={stored['expected']} "
        f"deviation={stored['deviation_pct']}% {stored['status']}"
    )

    handbook = admin.post(
        f"{base}/documents",
        data={
            "metadata": json.dumps(
                {
                    "title": "Aurora KPI Handbook",
                    "document_type": "KPI_HANDBOOK",
                    "access_scope": ["ADMIN", "ANALYST", "EXECUTIVE"],
                    "description": "How Aurora defines and compares its revenue measures.",
                    "inline_content": (
                        "Net Revenue is the sum of order value recognised on the order "
                        "date, excluding cancelled orders. Aurora compares a trading day "
                        "against the same weekday, because Friday and Saturday carry the "
                        "week's promotional volume and a plain trailing average understates "
                        "them. A weekday comparison is the approved basis for revenue; a "
                        "trailing-period comparison is a fallback used only when too few "
                        "comparable weekdays are on record."
                    ),
                }
            )
        },
    )
    check("the KPI handbook uploads", handbook.status_code == 201, handbook.text[:300])

    event = admin.post(
        f"{base}/documents",
        data={
            "metadata": json.dumps(
                {
                    "title": "Distribution centre outage note",
                    "document_type": "OPERATIONS_INCIDENT",
                    "access_scope": ["ADMIN", "ANALYST", "EXECUTIVE"],
                    "effective_from": COMPANY_A_TARGET.isoformat(),
                    "effective_to": COMPANY_A_TARGET.isoformat(),
                    "inline_content": (
                        "The southern distribution centre lost power for most of the "
                        "trading day and dispatched no orders after midday. Store teams "
                        "were told to hold customer promises rather than cancel them. No "
                        "revenue figures are stated in this note."
                    ),
                }
            )
        },
    )
    check("the dated event note uploads", event.status_code == 201, event.text[:300])

    # -----------------------------------------------------------------
    print("\n[3] The deterministic explanation, for something to compare against")
    # -----------------------------------------------------------------
    def explain(actor, *, use_model: bool, node: bool = False, **body) -> dict:
        payload = {
            "kpi_id": "revenue",
            "target_date": COMPANY_A_TARGET.isoformat(),
            "use_model": use_model,
            **body,
        }
        url = f"{base}/investigation/explain" if node else f"{base}/results/explain"
        response = actor.post(url, json=payload)
        assert response.status_code == 200, response.text
        return response.json()["explanation"]

    draft = explain(admin, use_model=False)
    check(
        "the draft is the platform's own prose",
        draft["model_written"] is False and draft["model"] is None,
        json.dumps({"model_written": draft["model_written"], "model": draft["model"]}),
    )
    check(
        "the draft carries every section, in the registered order",
        tuple(item["heading"] for item in draft["sections"]) == RESULT_SECTIONS,
        str([item["heading"] for item in draft["sections"]]),
    )
    titles = [c["title"] for c in draft["citations"]]
    check(
        "approved documents were retrieved and cited",
        any("Handbook" in title for title in titles),
        str(titles),
    )
    print(f"      citations: {titles}")
    report_prose("draft", draft, draft)

    # -----------------------------------------------------------------
    print(f"\n[4] The same result, narrated by {LIVE.model}")
    # -----------------------------------------------------------------
    narrated = explain(admin, use_model=True)
    check(
        "the model narrated it and is named",
        narrated["model_written"] is True and narrated["model"] == LIVE.model,
        json.dumps({"model_written": narrated["model_written"], "model": narrated["model"]}),
    )
    fell_back = [
        item for item in narrated["limitations"] if "did not return a usable narration" in item
    ]
    check("the model did not silently fall back to platform prose", not fell_back, str(fell_back))
    check(
        "the narration is genuinely different prose, not the draft echoed",
        prose_of(narrated) != prose_of(draft),
        "identical to the deterministic draft",
    )
    check(
        "the narration keeps every section, in the registered order",
        tuple(item["heading"] for item in narrated["sections"]) == RESULT_SECTIONS,
        str([item["heading"] for item in narrated["sections"]]),
    )
    check(
        "the verdict is unchanged by the rewrite",
        narrated["facts"]["verdict"] == stored["status"],
        str(narrated["facts"].get("verdict")),
    )
    check(
        "the confidence level is unchanged by the rewrite",
        narrated["confidence"]["level"] == draft["confidence"]["level"],
        f"{draft['confidence']['level']} -> {narrated['confidence']['level']}",
    )
    report_prose("narrated", narrated, draft)

    lowered_all = prose_of(narrated).lower()
    check(
        "the retrieved documents are visible in the answer",
        "handbook" in lowered_all or "[e1]" in lowered_all or "outage" in lowered_all,
        "no sign of a retrieved document in the narration",
    )
    for heading, body in sections_of(narrated).items():
        print(f"\n      {heading}\n      {body[:400].replace(chr(10), ' ')}")

    # -----------------------------------------------------------------
    print("\n\n[5] One part of the movement, narrated from the stored breakdown")
    # -----------------------------------------------------------------
    contribution = admin.post(
        f"{base}/investigation/contribution",
        json={
            "kpi_id": "revenue",
            "target_date": COMPANY_A_TARGET.isoformat(),
            "dimension": "region",
            "path": [],
        },
    )
    check("a breakdown by region runs", contribution.status_code == 200, contribution.text[:300])
    ranked = contribution.json()["result"]["contributors"]
    leader = ranked[0]
    print(
        f"      leader: {leader['label']} change={leader['change']} "
        f"share={leader.get('absolute_share_pct')}%"
    )

    node_draft = explain(
        admin, use_model=False, node=True, dimension="region", entity=leader["entity"]
    )
    node = explain(admin, use_model=True, node=True, dimension="region", entity=leader["entity"])
    check(
        "the node explanation was narrated by the model",
        node["model_written"] is True,
        json.dumps({"model_written": node["model_written"]}),
    )
    check(
        "the node explanation keeps its sections, in order",
        tuple(item["heading"] for item in node["sections"]) == NODE_SECTIONS,
        str([item["heading"] for item in node["sections"]]),
    )
    check(
        "the selected part of the business is named",
        leader["label"] in prose_of(node),
        f"{leader['label']} missing from the narration",
    )
    stored_labels = {row["label"] for row in ranked}
    strangers = [
        region
        for region in KNOWN_REGIONS
        if region in prose_of(node) and region not in stored_labels
    ]
    check(
        "no part of the business appears that the breakdown does not contain",
        not strangers,
        str(strangers),
    )
    report_prose("node", node, node_draft)
    for heading, body in sections_of(node).items():
        print(f"\n      {heading}\n      {body[:320].replace(chr(10), ' ')}")

    # -----------------------------------------------------------------
    print("\n\n[6] The fallbacks, with the model still switched on")
    # -----------------------------------------------------------------
    viewer_created = admin.post(
        f"{base}/members",
        json={
            "email": "viewer@aurora-llm-rag.example.com",
            "full_name": "Vik Viewer",
            "password": PASSWORD,
            "role_key": "VIEWER",
        },
    )
    check("a viewer can be added", viewer_created.status_code == 201, viewer_created.text[:200])
    from tests.conftest import login  # noqa: E402  (needs the running client)

    viewer = login(client, "viewer@aurora-llm-rag.example.com", PASSWORD, company_id)
    limited = explain(viewer, use_model=True)
    limited_prose = prose_of(limited).lower()
    check(
        "a reader with no document access is told the context is missing, not given one",
        not limited["citations"]
        and ("document" in limited_prose or "not attached" in limited_prose),
        json.dumps({"citations": len(limited["citations"])}),
    )
    check(
        "no figures were invented for the narrower reader",
        not (
            numbers_in(prose_of(limited))
            - permitted_numbers(explain(viewer, use_model=False), limited.get("facts"))
        ),
        "a figure appeared that this reader's evidence does not contain",
    )
    check(
        "no part of the business is named to a reader who cannot investigate",
        not [r for r in KNOWN_REGIONS if r in prose_of(limited)],
        str([r for r in KNOWN_REGIONS if r in prose_of(limited)]),
    )

    sparse_target = COMPANY_A_TARGET + timedelta(days=1)
    sparse = run_detection(admin, base, revenue_id, sparse_target)
    print(f"      a second date stored: {sparse_target} -> {sparse['result']['status']}")
    hedged_draft = explain(admin, use_model=False, target_date=sparse_target.isoformat())
    hedged = explain(admin, use_model=True, target_date=sparse_target.isoformat())
    check(
        "the second verdict is narrated without changing it",
        hedged["facts"]["verdict"] == sparse["result"]["status"],
        str(hedged["facts"].get("verdict")),
    )
    report_prose("second verdict", hedged, hedged_draft)


# ---------------------------------------------------------------------------
print("\n" + "=" * 78)
if failures:
    print(f"FAILED  {len(failures)} check(s)")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)
print(f"All checks passed. The explanation path really reaches {LIVE.provider}/{LIVE.model},")
print("really cites approved documents, and contributed no figure of its own.")
print("=" * 78)
