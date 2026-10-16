"""Cost telemetry: the in-function estimate, the reconciler, and trace IDs."""
import pytest
from botocore.exceptions import ClientError

import common
import reconciler
import tracing


def test_record_cost_bills_in_whole_milliseconds(monkeypatch, recorder, context):
    table = recorder()
    monkeypatch.setattr(common, "TABLE", table)
    monkeypatch.setattr(common.time, "perf_counter", lambda: 10.1004)  # 100.4 ms after start
    item = common.record_cost("d1", "classifier", context, started=10.0, s3_gets=2)
    assert item["billedMsEstimate"] == 101  # 100.4 ms rounds up
    assert item["gbSeconds"] == pytest.approx(0.25 * 0.101)  # 256 MB = 0.25 GB
    assert item["ddbWrites"] == 1  # the cost record itself
    expected = (0.25 * 0.101 * common.PRICES["lambda_gb_second"] + common.PRICES["lambda_request"]
                + 2 * common.PRICES["s3_get"] + common.PRICES["ddb_write"])
    assert item["totalUsd"] == pytest.approx(expected)
    assert table.calls[0][1]["Item"]["sk"] == "COST#classifier"


@pytest.mark.parametrize("line, billed, memory, init", [
    ("REPORT RequestId: abc-1\tDuration: 182.40 ms\tBilled Duration: 183 ms\tMemory Size: 512 MB\t"
     "Max Memory Used: 90 MB\t", "183", "512", None),
    ("REPORT RequestId: abc-2\tDuration: 95.10 ms\tBilled Duration: 96 ms\tMemory Size: 256 MB\t"
     "Max Memory Used: 88 MB\tInit Duration: 640.55 ms\t", "96", "256", "640.55"),
])
def test_report_lines_are_parsed(line, billed, memory, init):
    m = reconciler.REPORT_RE.search(line)
    assert (m.group(2), m.group(3), m.group(4)) == (billed, memory, init)


def test_reconcile_uses_the_billed_duration(monkeypatch, recorder):
    db = recorder()
    monkeypatch.setattr(reconciler, "dynamodb", db)
    item = {"pk": {"S": "d1"}, "sk": {"S": "COST#extract-light"}, "component": {"S": "extract-light"},
            "storageOpsUsd": {"N": "0.000007"}}
    reconciler.reconcile(item, billed_ms=1000, memory_mb=1024, init_ms=0)
    first, second = db.calls
    assert first[1]["ConditionExpression"] == "attribute_not_exists(billedMsActual)"
    compute = float(first[1]["ExpressionAttributeValues"][":c"]["N"])
    assert compute == pytest.approx(1.0 * 1.0 * common.PRICES["lambda_gb_second"], rel=1e-6)
    assert second[1]["Key"]["sk"]["S"] == "COST#TOTAL"


def test_reconcile_is_idempotent(monkeypatch, recorder):
    def already_done(**kwargs):
        raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")

    db = recorder(update_item=already_done)
    monkeypatch.setattr(reconciler, "dynamodb", db)
    item = {"pk": {"S": "d1"}, "sk": {"S": "COST#validator"}, "component": {"S": "validator"},
            "storageOpsUsd": {"N": "0"}}
    reconciler.reconcile(item, billed_ms=50, memory_mb=128, init_ms=0)
    assert db.names() == ["update_item"]  # the total is not added to a second time


@pytest.mark.parametrize("header, expected", [
    ("Root=1-6ad25168-6d7d33e3ca0aa249a9a8210f;Parent=53995c3f42cd8ad8;Sampled=1",
     "1-6ad25168-6d7d33e3ca0aa249a9a8210f"),
    ("Root=1-6ad25168-6d7d33e3ca0aa249a9a8210f;Parent=53995c3f42cd8ad8;Sampled=0", None),
    ("", None),
])
def test_only_sampled_traces_are_reported(monkeypatch, header, expected):
    monkeypatch.setenv("_X_AMZN_TRACE_ID", header)
    assert tracing.sampled_trace_id() == expected
