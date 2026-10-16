"""Scores a PDF's complexity and picks a lane, reading as little of the file as possible.

A PDF stores its page count in the page tree's root (/Count), which the catalogue points
to, and the catalogue is found from the trailer at the end of the file. Instead of
downloading the whole document, the classifier reads it through S3 byte-range requests
in 64 KB blocks, so pypdf fetches only the blocks it needs: usually the first and the
last. If the file is unusual or slightly malformed, it falls back to downloading the
whole file and parsing it leniently.
"""
import io
import os

import boto3
from pypdf import PdfReader

from tracing import annotate, tracer
from common import record_cost, start_timer

s3 = boto3.client("s3")
LIGHT_MAX_SCORE = float(os.environ.get("LIGHT_MAX_SCORE", 120))  # set in template.yaml


class S3RangeReader(io.RawIOBase):
    """A read-only, seekable file over an S3 object that fetches 64 KB blocks on demand."""

    BLOCK = 64 * 1024

    def __init__(self, bucket, key, size):
        super().__init__()
        self.bucket, self.key, self.size = bucket, key, size
        self.pos = 0
        self.blocks = {}
        self.requests = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def _block(self, index):
        if index not in self.blocks:
            start = index * self.BLOCK
            end = min(self.size, start + self.BLOCK) - 1
            self.blocks[index] = s3.get_object(Bucket=self.bucket, Key=self.key,
                                               Range=f"bytes={start}-{end}")["Body"].read()
            self.requests += 1
        return self.blocks[index]

    def read(self, size=-1):
        if size is None or size < 0:
            size = self.size - self.pos
        size = max(0, min(size, self.size - self.pos))
        out = bytearray()
        while size > 0:
            index, offset = divmod(self.pos, self.BLOCK)
            chunk = self._block(index)[offset:offset + size]
            if not chunk:
                break
            out += chunk
            self.pos += len(chunk)
            size -= len(chunk)
        return bytes(out)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def count_pages(bucket, key, size):
    """Return (pages, S3 GET requests made). Reads the page tree's /Count when possible."""
    reader = S3RangeReader(bucket, key, size)
    try:
        # Strict mode: pypdf's lenient mode re-checks every object in the file, which
        # would fetch every block. Slightly malformed files fail here and fall back.
        pdf = PdfReader(reader, strict=True)
        pages = int(pdf.trailer["/Root"]["/Pages"]["/Count"])
        if pages > 0:
            return pages, reader.requests
    except Exception as exc:  # unusual structure: fall back to the whole file below
        print(f"Range read failed for {key}: {exc!r}; downloading the whole file")
    data = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return len(PdfReader(io.BytesIO(data)).pages), reader.requests + 1


@tracer.capture_lambda_handler
def handler(event, context):
    started = start_timer()
    ops = {"s3_gets": 0}
    extra = {"mode": event["mode"], "failed": True}
    try:
        annotate(docId=event["docId"], mode=event["mode"])
        with tracer.provider.in_subsegment("## read page count"):
            pages, ops["s3_gets"] = count_pages(event["bucket"], event["key"], int(event["sizeBytes"]))
        size_mb = int(event["sizeBytes"]) / (1024 * 1024)

        # Page count drives text-extraction time most strongly; size adds weight for
        # image-heavy files. One megabyte counts the same as ten pages.
        score = pages + 10 * size_mb
        lane = "light" if score <= LIGHT_MAX_SCORE else "heavy"
        annotate(lane=lane, pages=pages)
        extra.update({"failed": False, "lane": lane, "pages": pages, "score": round(score, 2)})
        return {**event, "pages": pages, "sizeMb": round(size_mb, 3),
                "score": round(score, 2), "lane": lane}
    finally:
        # Runs on success and on failure, so failed documents are costed too.
        record_cost(event["docId"], "classifier", context, started, extra=extra, **ops)
