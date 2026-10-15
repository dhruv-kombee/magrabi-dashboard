#!/usr/bin/env python3
"""Dedicated telemetry count collector; never imports the deployment portal app.

Example: python -P backend/traffic_counts_cli.py --start 2026-10-09T00:00:00+05:30
  --end 2026-10-14T00:00:00+05:30 --timezone Asia/Kolkata --output counts.csv
Credentials are supplied through server environment variables, never command-line arguments.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from traffic_counts.catalog import SOURCES
from traffic_counts.service import TrafficReports, InvalidRequest, csv_export


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, help="Inclusive ISO timestamp with timezone, whole minute")
    parser.add_argument("--end", required=True, help="Exclusive ISO timestamp with timezone, whole minute")
    parser.add_argument("--timezone", choices=("Asia/Kolkata", "UTC"), default="Asia/Kolkata")
    parser.add_argument("--source", action="append", choices=list(SOURCES), dest="sources")
    parser.add_argument("--output", required=True, help="New .csv or .json output path (will not overwrite)")
    parser.add_argument("--cache-dir", default=str(Path(__file__).resolve().parent / "traffic_reports"))
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.suffix.lower() not in (".csv", ".json") or output.exists():
        parser.error("Use a new .csv or .json output filename.")
    reports = TrafficReports(args.cache_dir)
    try:
        started = reports.start({"start": args.start, "end": args.end, "timezone": args.timezone,
                                 "sources": args.sources or list(SOURCES)})
        last = -1
        while True:
            report = reports.get(started["id"])
            complete = report["progress"]["completed"]
            if complete != last:
                print(f"Chunks processed: {complete}/{report['progress']['total']}", file=sys.stderr)
                last = complete
            if report["status"] != "running":
                break
            time.sleep(1)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8", newline="") as stream:
            stream.write(csv_export(report) if output.suffix.lower() == ".csv" else json.dumps(report, indent=2))
        print(f"{report['status']}: {output}")
        return 0 if report["status"] == "complete" else 2
    except InvalidRequest as exc:
        parser.error(str(exc))
    except OSError:
        print("Unable to write the report or local cache. Check the output directory.", file=sys.stderr)
        return 3
    finally:
        reports.close()


if __name__ == "__main__":
    raise SystemExit(main())
