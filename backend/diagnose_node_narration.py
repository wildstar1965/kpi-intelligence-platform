"""Why a node narration fell back to platform prose, in the model's own output.

``verify_llm_rag_explanation.py`` reports *that* the entity-level explanation was
not model-written. It cannot report why, because ``narrate`` is built to swallow
the reason: a model failure must never break an explanation, so the raw response
is discarded and the deterministic draft is returned with one limitation appended.

This script keeps the same behaviour and prints what was discarded. It traces
``_split_sections`` -- the one place a usable narration is distinguished from an
unusable one -- so a fallback names its own cause:

  * a heading the model never wrote (or wrote differently);
  * headings written out of the registered order;
  * a heading with no body under it;
  * or an empty response, which means the call itself failed.

Run:  ../.venv313/Scripts/python.exe diagnose_node_narration.py

Builds its own scratch database and tenant, reads .env for the model, changes
nothing. Delete it once the node path narrates reliably.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

TMP = Path(__file__).resolve().parent / "tests" / "_tmp"
TMP.mkdir(parents=True, exist_ok=True)
DB = TMP / "diagnose_node.db"
if DB.exists():
    DB.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{DB.as_posix()}"
os.environ["DOCUMENT_STORAGE_DIR"] = str(TMP / "diagnose_node_documents")
os.environ["SECRET_KEY"] = "diagnose-node-secret-not-for-production-0123456789"
os.environ["ENVIRONMENT"] = "test"

from app.core.config import get_settings  # noqa: E402
from app.llm.config import llm_config_from_settings  # noqa: E402

SETTINGS = get_settings()
LIVE = llm_config_from_settings(SETTINGS)

from fastapi.testclient import TestClient  # noqa: E402

import app.copilot.explain as explain_module  # noqa: E402
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.seed.bootstrap import sync_reference_data  # noqa: E402
from app.services.explanation import NODE_SECTIONS  # noqa: E402
from tests.fixture_generalization import COMPANY_A_TARGET, build_company_a_source  # noqa: E402
from tests.test_detection_generalization import (  # noqa: E402
    approve_bucket_config,
    provision,
    run_detection,
)
from tests.test_investigation_contribution import register_kpi_with_dimensions  # noqa: E402

# `tests.conftest` pinned LLM_ENABLED=false on import; the deployment's own values
# go back on the live settings object, exactly as the verification script does.
SETTINGS.llm_enabled = LIVE.enabled
SETTINGS.llm_provider = LIVE.provider
SETTINGS.llm_tool_calling_enabled = LIVE.tool_calling_enabled

print(json.dumps(LIVE.describe()))
if not LIVE.is_available:
    raise SystemExit(f"No model configured: {LIVE.unavailable_reason}")


# --------------------------------------------------------------------------- trace
# Two traces, because there are two places a heading can go missing and they need
# different fixes. `_capped` sees what the model actually returned; `_split_sections`
# sees what survived the platform's own word budget. If a heading is present in the
# first and absent in the second, the budget destroyed a usable narration; if it is
# absent from both, the model (or its output-token limit) never wrote it.
_original_capped = explain_module._capped
_original_split = explain_module._split_sections
seen: list[str] = []
raw: list[str] = []


def traced_capped(text: str, limit: int) -> str:
    raw.append(text)
    result = _original_capped(text, limit)
    print("\n" + "-" * 78)
    print(
        f"model returned {len(text.split())} words / {len(text)} chars; "
        f"budget {limit} words -> {len(result.split())} words kept"
        + ("  (TRUNCATED)" if result != text else "")
    )
    upper_raw, upper_kept = text.upper(), result.upper()
    for heading in NODE_SECTIONS:
        in_raw = upper_raw.find(heading) >= 0
        in_kept = upper_kept.find(heading) >= 0
        mark = "ok" if in_kept else ("LOST TO BUDGET" if in_raw else "NEVER WRITTEN")
        print(f"  {mark:>14}  {heading}")
    return result


explain_module._capped = traced_capped


def traced(text: str, order: tuple[str, ...]) -> dict[str, str] | None:
    result = _original_split(text, order)
    seen.append(text)
    print("\n" + "=" * 78)
    print(f"narration {'parsed' if result else 'REJECTED'}  "
          f"({len(text.split())} words, {len(text)} chars, {len(order)} headings expected)")
    print("=" * 78)
    if result is None:
        upper = text.upper()
        for heading in order:
            index = upper.find(heading)
            print(f"  {'found @' + str(index) if index >= 0 else 'MISSING'}  {heading}")
        found = sorted(
            ((upper.find(h), h) for h in order if upper.find(h) >= 0), key=lambda pair: pair[0]
        )
        written = [h for _, h in found]
        if written != [h for h in order if h in written]:
            print(f"  ORDER WRITTEN: {written}")
        for heading in order:
            index = upper.find(heading)
            if index < 0:
                continue
            start = index + len(heading)
            nxt = [pos for pos, _ in found if pos > index]
            body = text[start : (nxt[0] if nxt else len(text))].strip().lstrip(":").strip()
            if not body:
                print(f"  EMPTY BODY under {heading}")
        print("\n--- text as _split_sections saw it (post-budget) ------------------")
        print(text if text else "(empty: the call itself failed or returned nothing)")
        print("--- what the model actually returned, in full ---------------------")
        print(raw[-1] if raw else "(nothing recorded)")
        print("--- end -----------------------------------------------------------")
    return result


explain_module._split_sections = traced

# --------------------------------------------------------------------------- setup
Base.metadata.create_all(bind=engine)
session = SessionLocal()
try:
    sync_reference_data(session)
    session.commit()
finally:
    session.close()

seeded = build_company_a_source(TMP / "diagnose_node_source.db")

with TestClient(create_app()) as client:
    admin, base, tables = provision(
        client,
        email="admin@diagnose-node.example.com",
        company_name="Diagnose Node",
        source_name="Diagnose Commerce",
        source_path=seeded["path"],
        scope={"orders": "order_date"},
    )
    revenue_id = register_kpi_with_dimensions(admin, base, source_table_id=tables["orders"]["id"])
    approve_bucket_config(
        admin,
        base,
        config_key="diagnose-node-weekly",
        name="Diagnose weekly trading pattern",
        buckets={
            "same_day_of_week": {"enabled": True, "days": ["FRI"]},
            "yoy_period": {"enabled": True},
        },
    )
    stored = run_detection(admin, base, revenue_id, COMPANY_A_TARGET)["result"]
    print(f"stored: {stored['kpi']} {stored['target_date']} {stored['status']}")

    breakdown = admin.post(
        f"{base}/investigation/contribution",
        json={
            "kpi_id": "revenue",
            "target_date": COMPANY_A_TARGET.isoformat(),
            "dimension": "region",
            "path": [],
        },
    )
    assert breakdown.status_code == 200, breakdown.text
    leader = breakdown.json()["result"]["contributors"][0]
    print(f"leader: {leader['label']}  share={leader.get('absolute_share_pct')}%")

    # Three attempts: a fallback that happens once is a slow or unlucky generation,
    # one that happens every time is the prompt or the token budget.
    for attempt in range(1, 4):
        print(f"\n######## attempt {attempt} ########")
        response = admin.post(
            f"{base}/investigation/explain",
            json={
                "kpi_id": "revenue",
                "target_date": COMPANY_A_TARGET.isoformat(),
                "dimension": "region",
                "entity": leader["entity"],
                "use_model": True,
            },
        )
        assert response.status_code == 200, response.text
        explanation = response.json()["explanation"]
        print(
            f"model_written={explanation['model_written']} model={explanation['model']} "
            f"sections={len(explanation['sections'])}/{len(NODE_SECTIONS)}"
        )
        fell_back = [
            item for item in explanation["limitations"] if "usable narration" in item
        ]
        if fell_back:
            print(f"limitation added: {fell_back[0]}")
