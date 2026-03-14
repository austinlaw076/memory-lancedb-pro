# Graphiti E2E Benchmark Report

- Timestamp: 2026-03-03T04:51:39.454Z
- Status: **PASS**
- Base URL: `http://127.0.0.1:8001`
- Scope: `global`
- Query: `scope/global mapping`
- Iterations: 20
- Concurrency: 2
- Warmup: 2
- Settle Delay: 120ms
- Token provided: yes (GRAPHITI_API_TOKEN)
- Raw JSON: `docs/reports/graphiti-benchmark/graphiti-benchmark-20260303_045139.json`

## Tool Resolution

- addEpisodeTool: `add_memory`
- searchFactsTool: `search_memory_facts`
- searchNodesTool: `search_nodes`

## Workload Summary

- total: 20
- success: 20
- failed: 0
- error rate: 0.00%

## Latency Stats (ms)

| Metric | count | min | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| add_episode | 20 | 5 | 11.75 | 5 | 38 | 40 | 40 |
| search_facts | 20 | 136 | 168.1 | 163 | 206 | 225 | 225 |
| search_nodes | 20 | 132 | 218.8 | 168 | 365 | 512 | 512 |
| case_total | 20 | 395 | 519.7 | 508 | 695 | 813 | 813 |

## Warmup

- configured: 2
- passed: 2
- failed: 0

## Notes

- All benchmark cases passed.

