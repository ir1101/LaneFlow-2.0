# LaneFlow cost comparison (measured, ap-southeast-2)

## Round r1

| File | Pages | Adaptive lane | Adaptive processing (USD) | Baseline processing (USD) | Saving | Adaptive total incl. orchestration (USD) | Baseline total (USD) |
|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 0.00001090 | 0.00004688 | 76.8% | 0.00014115 | 0.00012674 |
| doc-003p.pdf | 3 | light | 0.00001108 | 0.00001488 | 25.6% | 0.00014108 | 0.00009505 |
| doc-008p.pdf | 8 | light | 0.00001163 | 0.00001669 | 30.3% | 0.00014181 | 0.00009685 |
| doc-015p.pdf | 15 | light | 0.00001278 | 0.00001739 | 26.5% | 0.00014299 | 0.00009761 |
| doc-025p.pdf | 25 | light | 0.00001418 | 0.00002076 | 31.7% | 0.00014404 | 0.00010102 |
| doc-040p.pdf | 40 | heavy | 0.00003953 | 0.00002405 | -64.4% | 0.00016973 | 0.00010402 |
| doc-080p.pdf | 80 | heavy | 0.00002609 | 0.00003372 | 22.6% | 0.00015630 | 0.00011391 |
| doc-150p.pdf | 150 | heavy | 0.00003679 | 0.00005319 | 30.8% | 0.00016701 | 0.00013335 |
| doc-300p.pdf | 300 | heavy | 0.00006118 | 0.00009240 | 33.8% | 0.00019138 | 0.00017262 |

Processing cost, all files: adaptive 0.00022416, baseline 0.00031996, saving 29.9%.
Total cost including ingestion and Step Functions: adaptive 0.00139551, baseline 0.00104117, saving -34.0%.

## Round r2

| File | Pages | Adaptive lane | Adaptive processing (USD) | Baseline processing (USD) | Saving | Adaptive total incl. orchestration (USD) | Baseline total (USD) |
|---|---|---|---|---|---|---|---|
| doc-001p.pdf | 1 | light | 0.00001141 | 0.00001340 | 14.8% | 0.00014225 | 0.00009328 |
| doc-003p.pdf | 3 | light | 0.00000993 | 0.00001234 | 19.5% | 0.00013977 | 0.00009219 |
| doc-008p.pdf | 8 | light | 0.00001071 | 0.00001516 | 29.3% | 0.00014055 | 0.00009500 |
| doc-015p.pdf | 15 | light | 0.00001284 | 0.00001794 | 28.4% | 0.00014272 | 0.00009781 |
| doc-025p.pdf | 25 | light | 0.00001427 | 0.00001970 | 27.6% | 0.00014409 | 0.00009959 |
| doc-040p.pdf | 40 | heavy | 0.00002072 | 0.00002413 | 14.1% | 0.00015090 | 0.00010404 |
| doc-080p.pdf | 80 | heavy | 0.00002580 | 0.00003462 | 25.5% | 0.00015564 | 0.00011481 |
| doc-150p.pdf | 150 | heavy | 0.00003731 | 0.00005480 | 31.9% | 0.00016750 | 0.00013500 |
| doc-300p.pdf | 300 | heavy | 0.00006110 | 0.00009639 | 36.6% | 0.00019140 | 0.00017661 |

Processing cost, all files: adaptive 0.00020410, baseline 0.00028847, saving 29.2%.
Total cost including ingestion and Step Functions: adaptive 0.00137482, baseline 0.00100833, saving -36.3%.
