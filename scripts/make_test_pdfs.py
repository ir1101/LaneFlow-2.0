"""Generate text PDFs of known page counts for testing, with no extra libraries.

Usage: python scripts/make_test_pdfs.py
Writes to test-data/: doc-001p.pdf ... doc-300p.pdf, plus not-a-pdf.pdf for the rejection test.
"""
import random
from pathlib import Path

PAGE_COUNTS = [1, 3, 8, 15, 25, 40, 80, 150, 300]
WORDS = ("cloud serverless event queue lambda bucket object routing lane cost memory "
         "duration request storage table state machine retry alarm metric encryption "
         "policy role document page text extract classifier baseline adaptive").split()
OUT = Path(__file__).resolve().parent.parent / "test-data"


def page_stream(page_no, rng):
    lines = [f"BT /F1 10 Tf 50 800 Td 12 TL (LaneFlow test document, page {page_no}) Tj"]
    for _ in range(60):
        line = " ".join(rng.choice(WORDS) for _ in range(14))
        lines.append(f"T* ({line}) Tj")
    lines.append("ET")
    return "\n".join(lines).encode("latin-1")


def build_pdf(pages, seed):
    rng = random.Random(seed)
    objects = []  # each entry is the body of object number index + 1

    font_id = 3
    page_ids = []
    objects.append(None)  # 1: catalog, filled below
    objects.append(None)  # 2: pages tree, filled below
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for n in range(1, pages + 1):
        stream = page_stream(n, rng)
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content_id = len(objects)
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                       b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                       % (font_id, content_id))
        page_ids.append(len(objects))
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{i} 0 R" for i in page_ids).encode()
    objects[1] = b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % pages

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objects) + 1, xref_at))
    return bytes(out)


def main():
    OUT.mkdir(exist_ok=True)
    for count in PAGE_COUNTS:
        path = OUT / f"doc-{count:03d}p.pdf"
        path.write_bytes(build_pdf(count, seed=count))
        print(f"{path.name}: {path.stat().st_size} bytes")
    (OUT / "not-a-pdf.pdf").write_text("This is plain text pretending to be a PDF.")
    print("not-a-pdf.pdf: rejection test file")


if __name__ == "__main__":
    main()
