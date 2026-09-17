# Local log analysis

`cctl logs` reads local structured log files offline. Identity flags do not
filter records; use `--project-name`, `--session-name`, or `--conversation-id`.
Read a ranked report first, then inspect the trace responsible for a finding.

```sh
cctl logs report --in .cc/temp/server.log
cctl logs trace trace-one --in .cc/temp/server.log
cctl logs compare --before .cc/temp/before.log --after .cc/temp/after.log
```

The default report bounds ranked sections; `--top` selects their size. Use
`--full` for the complete analysis. `--json` puts inline analysis under
`payload.data`; `--full --out` writes it as an artifact with a bounded summary.

```sh
cctl logs report --in .cc/temp/server.log --full --out .cc/temp/analysis.json
cctl logs trace trace-one --in .cc/temp/server.log --speedscope --out .cc/temp/trace.speedscope.json
```

`--speedscope` selects the exact trace export and `--out` chooses its destination.
The receipt reports the artifact path, media type, byte count, and SHA-256.
Use trace ids and measured timings as evidence; an unexplained interval alone
does not identify the component responsible.
