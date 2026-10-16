# LaneFlow cost comparison: final measurement

Region ap-southeast-2 (Sydney), Express workflow, rounds m1, m2, m3, m4, m5, 91 documents. All Lambda figures use AWS's own Billed Duration.

- **Processing** = classifier + right-sized extractor (adaptive), or the 3008 MB extractor (baseline), including its S3 and DynamoDB requests.
- **Production total** = processing + validator + dispatcher + Express execution.
- Medians are taken over **warm runs only**; runs that paid a cold start are reported separately below. Measurement overhead is excluded from both and reported separately.

## Steady-state cost per document (median of warm runs, USD)

| File | Pages | Lane | Warm runs (A/B) | Adaptive processing | Baseline processing | Processing saving | Adaptive production total | Baseline production total | Total saving |
|---|---|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 4/5 | 0.00000935 | 0.00001198 | 21.9% | 0.00001477 | 0.00001662 | 11.2% |
| doc-003p.pdf | 3 | light | 5/5 | 0.00000839 | 0.00001041 | 19.5% | 0.00001318 | 0.00001507 | 12.5% |
| doc-008p.pdf | 8 | light | 5/5 | 0.00000914 | 0.00001261 | 27.5% | 0.00001398 | 0.00001739 | 19.6% |
| doc-015p.pdf | 15 | light | 5/5 | 0.00001058 | 0.00001410 | 25.0% | 0.00001562 | 0.00001882 | 17.0% |
| doc-025p.pdf | 25 | light | 5/5 | 0.00001186 | 0.00001637 | 27.6% | 0.00001722 | 0.00002114 | 18.5% |
| doc-040p.pdf | 40 | heavy | 5/5 | 0.00001849 | 0.00001801 | -2.7% | 0.00002377 | 0.00002290 | -3.8% |
| doc-080p.pdf | 80 | heavy | 5/5 | 0.00002383 | 0.00002502 | 4.8% | 0.00002958 | 0.00003026 | 2.2% |
| doc-150p.pdf | 150 | heavy | 5/4 | 0.00003584 | 0.00003566 | -0.5% | 0.00004184 | 0.00004122 | -1.5% |
| doc-300p.pdf | 300 | heavy | 5/5 | 0.00005906 | 0.00006106 | 3.3% | 0.00006658 | 0.00006743 | 1.3% |

Totals below add one document of each size (an even mix of the test set).

- **Processing:** adaptive 0.00018654, baseline 0.00020522, saving **9.1%**.
- **Production total:** adaptive 0.00023653, baseline 0.00025084, saving **5.7%**.
- Small files (light lane): processing saving 24.7%, total saving 16.0%.
- Large files (heavy lane): processing saving 1.8%, total saving 0.0%.

## Run-to-run variability (processing cost, warm runs)

| File | Adaptive min to max | Baseline min to max | Baseline extractor time, min to max (ms) |
|---|---|---|---|
| doc-001p.pdf | 0.00000914 to 0.00000949 | 0.00001139 to 0.00001363 | 116 to 173 |
| doc-003p.pdf | 0.00000832 to 0.00000919 | 0.00001010 to 0.00001065 | 83 to 97 |
| doc-008p.pdf | 0.00000898 to 0.00000972 | 0.00001120 to 0.00001417 | 111 to 187 |
| doc-015p.pdf | 0.00000992 to 0.00001110 | 0.00001312 to 0.00001527 | 160 to 215 |
| doc-025p.pdf | 0.00001183 to 0.00001214 | 0.00001558 to 0.00001676 | 223 to 253 |
| doc-040p.pdf | 0.00001782 to 0.00001905 | 0.00001797 to 0.00001907 | 284 to 312 |
| doc-080p.pdf | 0.00002372 to 0.00002493 | 0.00002444 to 0.00002600 | 449 to 489 |
| doc-150p.pdf | 0.00003491 to 0.00003635 | 0.00003532 to 0.00003752 | 727 to 783 |
| doc-300p.pdf | 0.00005882 to 0.00006072 | 0.00005969 to 0.00009255 | 1349 to 2188 |

## Cold starts

- Adaptive: 2 of 46 documents hit at least one cold start; median extra cost per affected document 0.00001287 USD.
- Baseline: 1 of 45 documents hit at least one cold start; median extra cost per affected document 0.00002963 USD.

Adaptive mode spreads work across more functions (classifier plus two lanes), so at low or bursty volume it starts more fresh execution environments than the single baseline function.

## Measurement overhead (median per document, USD)

- Adaptive: 0.00000718 (cost-record writes plus Step Functions logs at level ALL). Not needed in production.
- Baseline: 0.00000504 (cost-record writes plus Step Functions logs at level ALL). Not needed in production.

## Orchestration choice: Express versus Standard (median per document, USD)

- Adaptive: Express 0.00001723, Standard 0.00014031 (Standard is 8.1 times dearer).
- Baseline: Express 0.00002093, Standard 0.00009456 (Standard is 4.5 times dearer).

## Data quality

- Every document matched its log records.