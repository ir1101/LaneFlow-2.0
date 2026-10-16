"""The classifier: page counts from byte ranges, and the lane decision."""
import io

import pytest
from pypdf.errors import PyPdfError

import classifier


class RangeS3:
    """Serves byte ranges of an in-memory file, like S3 GetObject with a Range header."""

    def __init__(self, data):
        self.data = data
        self.requests = 0

    def get_object(self, Bucket, Key, Range=None):
        self.requests += 1
        data = self.data
        if Range:
            start, end = map(int, Range.split("=")[1].split("-"))
            data = data[start:end + 1]
        return {"Body": io.BytesIO(data)}


@pytest.mark.parametrize("pages", [1, 25, 300])
def test_page_count_is_exact(monkeypatch, make_pdf, pages):
    pdf = make_pdf(pages)
    monkeypatch.setattr(classifier, "s3", RangeS3(pdf))
    counted, _ = classifier.count_pages("bucket", "doc.pdf", len(pdf))
    assert counted == pages


def test_large_pdf_needs_only_a_couple_of_small_reads(monkeypatch, make_pdf):
    pdf = make_pdf(300)  # about 2 MB
    fake = RangeS3(pdf)
    monkeypatch.setattr(classifier, "s3", fake)
    _, requests = classifier.count_pages("bucket", "doc.pdf", len(pdf))
    assert requests == fake.requests <= 2
    assert len(pdf) > 30 * classifier.S3RangeReader.BLOCK  # so reading it all would take 30+ blocks


def test_broken_pdf_raises_after_falling_back(monkeypatch):
    broken = b"%PDF-1.4\n" + bytes(range(256)) * 16
    monkeypatch.setattr(classifier, "s3", RangeS3(broken))
    with pytest.raises(PyPdfError):
        classifier.count_pages("bucket", "broken.pdf", len(broken))


def run(monkeypatch, context, pages, size_bytes):
    costs = []
    monkeypatch.setattr(classifier, "count_pages", lambda b, k, s: (pages, 2))
    monkeypatch.setattr(classifier, "record_cost", lambda *a, **k: costs.append(k))
    event = {"docId": "d1", "bucket": "b", "key": "adaptive/d1/x.pdf", "mode": "adaptive",
             "sizeBytes": size_bytes}
    return classifier.handler(event, context), costs


def test_small_document_takes_the_light_lane(monkeypatch, context):
    out, costs = run(monkeypatch, context, pages=80, size_bytes=550_000)
    assert out["lane"] == "light" and out["pages"] == 80
    assert costs[0]["extra"]["failed"] is False and costs[0]["s3_gets"] == 2


def test_large_document_takes_the_heavy_lane(monkeypatch, context):
    out, _ = run(monkeypatch, context, pages=150, size_bytes=1_030_000)
    assert out["lane"] == "heavy"


def test_file_size_adds_weight(monkeypatch, context):
    # 20 pages but 12 MB, as an image-heavy file: 20 + 10 x 12 = 140, over the limit of 120.
    out, _ = run(monkeypatch, context, pages=20, size_bytes=12 * 1024 * 1024)
    assert out["score"] == pytest.approx(140) and out["lane"] == "heavy"


def test_failed_classification_is_still_costed(monkeypatch, context):
    costs = []

    def boom(*args):
        raise ValueError("unreadable")

    monkeypatch.setattr(classifier, "count_pages", boom)
    monkeypatch.setattr(classifier, "record_cost", lambda *a, **k: costs.append(k))
    with pytest.raises(ValueError):
        classifier.handler({"docId": "d1", "bucket": "b", "key": "k", "mode": "adaptive",
                            "sizeBytes": 10}, context)
    assert costs and costs[0]["extra"]["failed"] is True
