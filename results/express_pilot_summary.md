# LaneFlow cost comparison, Express workflow (measured, ap-southeast-2)

Processing = classifier + extractor Lambda (adaptive) or the 3008 MB extractor (baseline), including S3 and DynamoDB requests. Total adds the validator and dispatcher, the Express execution charge and the Step Functions log volume.

## Round e1

| File | Pages | Lane | Adaptive processing | Baseline processing | Processing saving | Adaptive total | Baseline total | Total saving |
|---|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 0.00001056 | 0.00003255 | 67.6% | 0.00002161 | 0.00004224 | 48.8% |
| doc-008p.pdf | 8 | light | 0.00001169 | 0.00001485 | 21.3% | 0.00002251 | 0.00002387 | 5.7% |
| doc-015p.pdf | 15 | light | 0.00001269 | 0.00001504 | 15.7% | 0.00002375 | 0.00002417 | 1.8% |
| doc-025p.pdf | 25 | light | 0.00001409 | 0.00001633 | 13.8% | 0.00002535 | 0.00002539 | 0.1% |
| doc-040p.pdf | 40 | heavy | 0.00003920 | 0.00001919 | -104.2% | 0.00005115 | 0.00002867 | -78.4% |
| doc-080p.pdf | 80 | heavy | 0.00002641 | 0.00002593 | -1.8% | 0.00003792 | 0.00003560 | -6.5% |
| doc-150p.pdf | 150 | heavy | 0.00003692 | 0.00003858 | 4.3% | 0.00004890 | 0.00004861 | -0.6% |
| doc-300p.pdf | 300 | heavy | 0.00006014 | 0.00006114 | 1.6% | 0.00007345 | 0.00007177 | -2.3% |

- Processing, all files: adaptive 0.00021169 USD, baseline 0.00022361 USD, saving 5.3%.
- Total with Express orchestration: adaptive 0.00030463 USD, baseline 0.00030031 USD, saving -1.4%.
- Of which Express execution charges: adaptive 0.00001821, baseline 0.00001342; Step Functions logs: adaptive 0.00003472, baseline 0.00002325.
- The same runs priced as a Standard workflow (per state transition): adaptive 0.00125170 USD, baseline 0.00086365 USD, saving -44.9%.

## Round e2

| File | Pages | Lane | Adaptive processing | Baseline processing | Processing saving | Adaptive total | Baseline total | Total saving |
|---|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 0.00001101 | 0.00001273 | 13.5% | 0.00002208 | 0.00002182 | -1.2% |
| doc-003p.pdf | 3 | light | 0.00001008 | 0.00001109 | 9.1% | 0.00002113 | 0.00002009 | -5.2% |
| doc-008p.pdf | 8 | light | 0.00001069 | 0.00001234 | 13.3% | 0.00002140 | 0.00002136 | -0.2% |
| doc-015p.pdf | 15 | light | 0.00001873 | 0.00001469 | -27.5% | 0.00003064 | 0.00002372 | -29.1% |
| doc-025p.pdf | 25 | light | 0.00001406 | 0.00001629 | 13.7% | 0.00002531 | 0.00002538 | 0.2% |
| doc-040p.pdf | 40 | heavy | 0.00002033 | 0.00001868 | -8.8% | 0.00003133 | 0.00002786 | -12.5% |
| doc-080p.pdf | 80 | heavy | 0.00002588 | 0.00002483 | -4.2% | 0.00003738 | 0.00003442 | -8.6% |
| doc-300p.pdf | 300 | heavy | 0.00006053 | 0.00006032 | -0.4% | 0.00007394 | 0.00007081 | -4.4% |

- Processing, all files: adaptive 0.00017132 USD, baseline 0.00017097 USD, saving -0.2%.
- Total with Express orchestration: adaptive 0.00026320 USD, baseline 0.00024545 USD, saving -7.2%.
- Of which Express execution charges: adaptive 0.00001665, baseline 0.00001175; Step Functions logs: adaptive 0.00003472, baseline 0.00002325.
- The same runs priced as a Standard workflow (per state transition): adaptive 0.00121183 USD, baseline 0.00081045 USD, saving -49.5%.
