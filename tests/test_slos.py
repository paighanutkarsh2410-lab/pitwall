import importlib.util
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).parent.parent / "scripts" / "slos.py"
spec = importlib.util.spec_from_file_location("slos", SCRIPT)
slos = importlib.util.module_from_spec(spec)
sys.modules["slos"] = slos  # dataclasses look their module up while the class is built
spec.loader.exec_module(slos)


def rules() -> dict:
    found = {}
    for group in yaml.safe_load(slos.render())["groups"]:
        for rule in group["rules"]:
            name = rule.get("alert") or f"{rule['record']}/{rule['labels']['slo']}"
            found[name] = rule
    return found


def test_the_committed_rules_match_the_slos():
    assert slos.OUTPUT.read_text(encoding="utf-8") == slos.render(), "Run: python scripts/slos.py"


def test_page_alerts_use_the_sre_workbook_burn_rates():
    page = rules()["PitwallTelemetryFreshnessBudgetPage"]["expr"]
    # A 99% objective leaves a 1% budget: page at 14.4x (1h, confirmed 5m) or 6x (6h, 30m).
    assert 'rate1h{slo="telemetry-freshness"} > 0.144' in page
    assert 'rate5m{slo="telemetry-freshness"} > 0.144' in page
    assert 'rate6h{slo="telemetry-freshness"} > 0.06' in page
    ticket = rules()["PitwallIngestValidityBudgetTicket"]["expr"]
    assert 'rate3d{slo="ingest-validity"} > 0.001' in ticket  # 99.9%: 1x of a 0.1% budget


def test_rare_event_slos_open_tickets_but_never_page():
    assert "PitwallLinkCatchUpBudgetTicket" in rules()
    assert "PitwallLinkCatchUpBudgetPage" not in rules()
    assert "PitwallTelemetryFreshnessBudgetPage" in rules()


def test_freshness_counts_late_events_as_errors():
    ratio = rules()["pitwall:slo_error_ratio:rate5m/telemetry-freshness"]["expr"]
    assert 'le=~"0.5"' in ratio and 'stage="api"' in ratio and "[5m]" in ratio
    board = rules()["pitwall:slo_error_ratio:rate5m/board-freshness"]["expr"]
    assert 'le=~"1|1.0"' in board  # the Python client writes "1.0"
    assert "or vector(0)" in ratio  # no errors yet still means a ratio of 0
    assert ratio.endswith("> 0)")  # no division by zero when nothing is flowing
    assert "$W" not in slos.render() and "{w}" not in slos.render()


def test_every_alert_has_a_runbook_that_exists():
    runbooks = Path(__file__).parent.parent / "docs" / "runbooks"
    for name, rule in rules().items():
        if "alert" in rule:
            url = rule["annotations"]["runbook_url"]
            assert (runbooks / url.rsplit("/", 1)[-1]).is_file(), f"{name}: no {url}"


def test_the_committed_dashboards_are_current():
    path = Path(__file__).parent.parent / "scripts" / "dashboards.py"
    dspec = importlib.util.spec_from_file_location("dashboards", path)
    dashboards = importlib.util.module_from_spec(dspec)
    sys.modules["dashboards"] = dashboards
    dspec.loader.exec_module(dashboards)
    for name, text in dashboards.render().items():
        assert (dashboards.OUT / name).read_text(encoding="utf-8") == text, (
            "Run: python scripts/dashboards.py"
        )
