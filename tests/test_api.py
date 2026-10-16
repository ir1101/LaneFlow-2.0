"""The website API: upload forms, input checks and routing."""
import json

import pytest

import api


def call(method, path, body=None, params=None):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "routeKey": f"{method} {path}", "pathParameters": params,
             "body": json.dumps(body) if body is not None else None}
    response = api.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


@pytest.fixture
def signer(monkeypatch, recorder):
    s3 = recorder(generate_presigned_post=lambda bucket, key, **k: {"url": "https://example", "fields": {"key": key}})
    monkeypatch.setattr(api, "s3", s3)
    return s3


def test_upload_form_is_pdf_only_small_and_short_lived(signer):
    status, body = call("POST", "/api/uploads", {"filename": "Quarterly report.pdf", "mode": "baseline"})
    assert status == 201
    kwargs = signer.calls[0][1]
    bucket, key = kwargs["_args"]
    assert bucket == "laneflow-uploads-test"
    assert key == f"baseline/{body['docId']}/Quarterly-report.pdf"
    assert {"Content-Type": "application/pdf"} in kwargs["Conditions"]
    assert ["content-length-range", 1, 25 * 1024 * 1024] in kwargs["Conditions"]
    assert kwargs["ExpiresIn"] == 300


def test_file_names_cannot_escape_their_folder(signer):
    status, body = call("POST", "/api/uploads", {"filename": "..\\..\\secret/../evil.pdf"})
    assert status == 201
    assert body["key"].endswith("/evil.pdf") and ".." not in body["key"]


@pytest.mark.parametrize("payload, message", [
    ({"filename": "notes.txt"}, "Only .pdf"),
    ({"filename": "a.pdf", "mode": "fastest"}, "Mode must be"),
])
def test_bad_upload_requests_are_refused(signer, payload, message):
    status, body = call("POST", "/api/uploads", payload)
    assert status == 400 and message in body["error"]
    assert not signer.calls


def test_document_ids_are_checked_before_any_lookup(monkeypatch, recorder):
    table = recorder()
    monkeypatch.setattr(api, "table", table)
    status, body = call("GET", "/api/documents/not-an-id", params={"docId": "not-an-id"})
    assert status == 400 and not table.calls


def test_unknown_routes_are_not_found():
    status, _ = call("GET", "/api/nothing-here")
    assert status == 404
