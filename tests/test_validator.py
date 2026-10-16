"""The validator: what is accepted, what is rejected, and where each goes."""
import io
import json

import pytest

import validator

DOC_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"


@pytest.fixture
def fakes(monkeypatch, recorder):
    s3 = recorder(get_object=lambda **k: {"Body": io.BytesIO(b"%PDF-")})
    sqs, sns, table = recorder(), recorder(), recorder()
    monkeypatch.setattr(validator, "s3", s3)
    monkeypatch.setattr(validator, "sqs", sqs)
    monkeypatch.setattr(validator, "sns", sns)
    monkeypatch.setattr(validator, "TABLE", table)
    monkeypatch.setattr(validator, "record_cost", lambda *a, **k: None)
    return s3, sqs, sns, table


def upload(key, size=2048):
    return {"Records": [{"s3": {"bucket": {"name": "uploads"}, "object": {"key": key, "size": size}}}]}


def test_a_real_pdf_is_queued(fakes, context):
    s3, sqs, sns, table = fakes
    validator.handler(upload("adaptive/report.pdf"), context)
    job = json.loads(sqs.calls[0][1]["MessageBody"])
    assert job["mode"] == "adaptive" and job["key"] == "adaptive/report.pdf"
    assert s3.calls[0][1]["Range"] == "bytes=0-4"  # only the signature is read
    assert table.calls[0][1]["Item"]["status"] == "QUEUED"
    assert not sns.calls


def test_baseline_prefix_sets_the_mode(fakes, context):
    _, sqs, _, _ = fakes
    validator.handler(upload("baseline/report.pdf"), context)
    assert json.loads(sqs.calls[0][1]["MessageBody"])["mode"] == "baseline"


def test_website_uploads_keep_their_document_id(fakes, context):
    _, sqs, _, _ = fakes
    validator.handler(upload(f"adaptive/{DOC_ID}/report.pdf"), context)
    assert json.loads(sqs.calls[0][1]["MessageBody"])["docId"] == DOC_ID


@pytest.mark.parametrize("key, size, reason", [
    ("adaptive/notes.txt", 100, "does not end in .pdf"),
    ("adaptive/empty.pdf", 0, "empty"),
    ("adaptive/huge.pdf", 26 * 1024 * 1024, "larger than"),
])
def test_bad_uploads_are_rejected_without_queueing(fakes, context, key, size, reason):
    _, sqs, sns, table = fakes
    validator.handler(upload(key, size), context)
    assert not sqs.calls
    assert reason in table.calls[0][1]["Item"]["rejectReason"]
    assert sns.calls[0][1]["MessageAttributes"]["outcome"]["StringValue"] == "rejected"


def test_a_fake_pdf_is_caught_by_its_signature(fakes, context, monkeypatch, recorder):
    _, sqs, _, table = fakes
    monkeypatch.setattr(validator, "s3", recorder(get_object=lambda **k: {"Body": io.BytesIO(b"This ")}))
    validator.handler(upload("adaptive/fake.pdf"), context)
    assert not sqs.calls
    assert table.calls[0][1]["Item"]["rejectReason"] == "file content is not a PDF"


def test_tuning_inputs_are_ignored(fakes, context):
    s3, sqs, sns, table = fakes
    validator.handler(upload("tuning/doc-300p.pdf"), context)
    assert not (s3.calls or sqs.calls or sns.calls or table.calls)
