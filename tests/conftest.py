"""Shared test set-up: environment variables, import paths and small fakes for AWS.

The functions create their AWS clients when imported, which needs only a region, not a
connection. Every test then swaps those clients for fakes, so nothing touches AWS.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "scripts")]

os.environ.update({
    "AWS_DEFAULT_REGION": "ap-southeast-2",
    "AWS_REGION": "ap-southeast-2",
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "POWERTOOLS_TRACE_DISABLED": "true",
    "TABLE_NAME": "laneflow-test",
    "QUEUE_URL": "https://sqs.ap-southeast-2.amazonaws.com/000000000000/laneflow-jobs",
    "TOPIC_ARN": "arn:aws:sns:ap-southeast-2:000000000000:laneflow-notifications",
    "STATE_MACHINE_ARN": "arn:aws:states:ap-southeast-2:000000000000:stateMachine:laneflow-pipeline-express",
    "LANE": "light",
    "CURATED_BUCKET": "laneflow-curated-test",
    "UPLOAD_BUCKET": "laneflow-uploads-test",
})


class FakeContext:
    """The parts of the Lambda context object the functions read."""
    function_name = "laneflow-test"
    aws_request_id = "req-0001"
    memory_limit_in_mb = "256"


class Recorder:
    """Stands in for any AWS client: records every call and answers from a lookup."""

    def __init__(self, **answers):
        self.calls = []
        self.answers = answers

    def __getattr__(self, name):
        def call(*args, **kwargs):
            recorded = {**kwargs, "_args": args} if args else kwargs
            self.calls.append((name, recorded))
            answer = self.answers.get(name)
            return answer(*args, **kwargs) if callable(answer) else (answer or {})
        return call

    def names(self):
        return [name for name, _ in self.calls]


@pytest.fixture
def context():
    return FakeContext()


@pytest.fixture
def recorder():
    return Recorder


@pytest.fixture(scope="session")
def make_pdf():
    """Builds a text PDF of a given page count with the project's own generator."""
    from make_test_pdfs import build_pdf
    return lambda pages: build_pdf(pages, seed=pages)
