# Graphiti E2E Benchmark Report

- Timestamp: 2026-03-03T05:06:26.048Z
- Status: **PASS**
- Base URL: `http://127.0.0.1:8001`
- Scope: `global`
- Query: `scope/global mapping`
- Iterations: 20
- Concurrency: 2
- Warmup: 2
- Settle Delay: 120ms
- Token provided: yes (GRAPHITI_API_TOKEN)
- Raw JSON: `docs/reports/graphiti-benchmark/graphiti-benchmark-20260303_050626.json`

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
| add_episode | 20 | 5 | 12.65 | 6 | 61 | 67 | 67 |
| search_facts | 20 | 152 | 256.35 | 216 | 397 | 873 | 873 |
| search_nodes | 20 | 154 | 225.45 | 222 | 314 | 334 | 334 |
| case_total | 20 | 451 | 615.75 | 582 | 753 | 1177 | 1177 |

## Warmup

- configured: 2
- passed: 2
- failed: 0

## Notes

- All benchmark cases passed.

