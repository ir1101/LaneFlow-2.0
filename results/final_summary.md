# LaneFlow cost comparison: final measurement

Region ap-southeast-2 (Sydney), Express workflow, rounds n1, n2, n3, n4, n5, 90 documents. All Lambda figures use AWS's own Billed Duration.

- **Processing** = classifier + right-sized extractor (adaptive), or the 3008 MB extractor (baseline), including its S3 and DynamoDB requests.
- **Production total** = processing + validator + dispatcher + Express execution.
- Medians are taken over **warm runs only**; runs that paid a cold start are reported separately below. Measurement overhead is excluded from both and reported separately.

## Steady-state cost per document (median of warm runs, USD)

| File | Pages | Lane | Warm runs (A/B) | Adaptive processing | Baseline processing | Processing saving | Adaptive production total | Baseline production total | Total saving |
|---|---|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 5/5 | 0.00000899 | 0.00001273 | 29.4% | 0.00001564 | 0.00001872 | 16.4% |
| doc-003p.pdf | 3 | light | 5/5 | 0.00000836 | 0.00001065 | 21.5% | 0.00001441 | 0.00001651 | 12.7% |
| doc-008p.pdf | 8 | light | 5/5 | 0.00000909 | 0.00001151 | 21.1% | 0.00001541 | 0.00001737 | 11.3% |
| doc-015p.pdf | 15 | light | 5/5 | 0.00001063 | 0.00001300 | 18.2% | 0.00001734 | 0.00001896 | 8.5% |
| doc-025p.pdf | 25 | light | 5/5 | 0.00001202 | 0.00001535 | 21.7% | 0.00001913 | 0.00002132 | 10.3% |
| doc-040p.pdf | 40 | light | 5/5 | 0.00001430 | 0.00001829 | 21.8% | 0.00002217 | 0.00002450 | 9.5% |
| doc-080p.pdf | 80 | light | 5/5 | 0.00002049 | 0.00002651 | 22.7% | 0.00003022 | 0.00003277 | 7.8% |
| doc-150p.pdf | 150 | heavy | 5/5 | 0.00003424 | 0.00004049 | 15.4% | 0.00004220 | 0.00004709 | 10.4% |
| doc-300p.pdf | 300 | heavy | 5/5 | 0.00005705 | 0.00007206 | 20.8% | 0.00006696 | 0.00007956 | 15.8% |

Totals below add one document of each size (an even mix of the test set).

- **Processing:** adaptive 0.00017518, baseline 0.00022059, saving **20.6%**.
- **Production total:** adaptive 0.00024348, baseline 0.00027679, saving **12.0%**.
- Small files (light lane): processing saving 22.4%, total saving 10.5%.
- Large files (heavy lane): processing saving 18.9%, total saving 13.8%.

## Run-to-run variability (processing cost, warm runs)

| File | Adaptive min to max | Baseline min to max | Baseline extractor time, min to max (ms) |
|---|---|---|---|
| doc-001p.pdf | 0.00000891 to 0.00000901 | 0.00001186 to 0.00001339 | 128 to 167 |
| doc-003p.pdf | 0.00000833 to 0.00000842 | 0.00001034 to 0.00001163 | 89 to 122 |
| doc-008p.pdf | 0.00000903 to 0.00000950 | 0.00001132 to 0.00001194 | 114 to 130 |
| doc-015p.pdf | 0.00001058 to 0.00001068 | 0.00001288 to 0.00001316 | 154 to 161 |
| doc-025p.pdf | 0.00001197 to 0.00001205 | 0.00001461 to 0.00001598 | 198 to 233 |
| doc-040p.pdf | 0.00001421 to 0.00001435 | 0.00001786 to 0.00001848 | 281 to 297 |
| doc-080p.pdf | 0.00001996 to 0.00002134 | 0.00002620 to 0.00002694 | 494 to 513 |
| doc-150p.pdf | 0.00003364 to 0.00003433 | 0.00003999 to 0.00004112 | 846 to 875 |
| doc-300p.pdf | 0.00005668 to 0.00005720 | 0.00007042 to 0.00007300 | 1623 to 1689 |

## Cold starts

- Adaptive: 0 of 45 documents hit at least one cold start; median extra cost per affected document 0.00000000 USD.
- Baseline: 0 of 45 documents hit at least one cold start; median extra cost per affected document 0.00000000 USD.

Adaptive mode spreads work across more functions (classifier plus two lanes), so at low or bursty volume it starts more fresh execution environments than the single baseline function.

## Measurement overhead (median per document, USD)

- Adaptive: 0.00000824 (cost-record writes plus Step Functions logs at level ALL). Not needed in production.
- Baseline: 0.00000609 (cost-record writes plus Step Functions logs at level ALL). Not needed in production.

## Orchestration choice: Express versus Standard (median per document, USD)

- Adaptive: Express 0.00001913, Standard 0.00016667 (Standard is 8.7 times dearer).
- Baseline: Express 0.00002132, Standard 0.00012000 (Standard is 5.6 times dearer).

## Data quality

- Every document matched its log records.