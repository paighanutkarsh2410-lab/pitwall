import pytest

from pitwall.delivery import KEYSEQ_HEADER, Deduplicator, KeySequencer, LinkTracker, keyseq_of


def test_each_key_is_numbered_from_zero():
    numbers = KeySequencer()
    assert [numbers.number(b"1") for _ in range(3)] == [0, 1, 2]
    assert numbers.number(b"44") == 0
    assert numbers.number(b"race") == 0
    assert numbers.number(b"1") == 3


def test_the_number_travels_in_a_header():
    assert keyseq_of([("pitwall-run", b"r"), (KEYSEQ_HEADER, b"17")]) == 17
    assert keyseq_of([(KEYSEQ_HEADER, b"x")]) is None
    assert keyseq_of(None) is None


def test_events_seen_again_are_duplicates():
    d = Deduplicator()
    assert not d.check("run-1", b"1", 0).duplicate
    assert not d.check("run-1", b"1", 1).duplicate
    assert d.check("run-1", b"1", 1).duplicate  # re-sent after an outage
    assert d.check("run-1", b"1", 0).duplicate
    assert not d.check("run-1", b"44", 1).duplicate  # another key is numbered separately


def test_a_jump_in_the_numbers_counts_the_missing_events():
    d = Deduplicator()
    d.check("run-1", b"1", 0)
    assert d.check("run-1", b"1", 4).missing == 3  # 1, 2 and 3 never arrived
    assert d.check("run-1", b"1", 5).missing == 0


def test_a_key_first_seen_mid_run_is_not_a_gap():
    # After a restart or a partition rebalance, this pod sees a key from the middle of the run.
    d = Deduplicator()
    assert d.check("run-1", b"1", 812).missing == 0


def test_a_new_run_starts_the_numbers_again_and_old_runs_are_ignored():
    d = Deduplicator()
    d.check("run-2", b"1", 50)
    assert not d.check("run-3", b"1", 0).duplicate  # a new run: numbering restarts
    assert d.check("run-2", b"1", 51).duplicate is False  # an older run's straggler: ignored
    assert d.run == "run-3"


def test_unnumbered_events_pass_through():
    d = Deduplicator()
    assert not d.check(None, b"1", 3).duplicate
    assert not d.check("run-1", b"1", None).duplicate


def test_an_outage_and_its_catch_up_are_timed():
    link = LinkTracker()
    link.sent(100.0, True)  # steady: the last good send
    link.failed(103.0)  # the link breaks
    link.failed(110.0)  # still broken
    outage, recovery = link.sent(160.0, False)  # back, with a backlog still at the track
    assert outage is not None and outage.lasted == pytest.approx(60.0)  # from the last good send
    assert recovery is None and link.state == "catching_up"
    _, recovery = link.sent(170.0, False)  # still behind
    assert recovery is None
    _, recovery = link.sent(174.0, True)  # nothing left unread: current again
    assert recovery is not None
    assert recovery.outage == pytest.approx(60.0) and recovery.catch_up == pytest.approx(14.0)
    assert link.state == "up"


def test_a_link_that_never_failed_reports_nothing():
    link = LinkTracker()
    assert link.sent(1.0, True) == (None, None)
    assert link.history == []
