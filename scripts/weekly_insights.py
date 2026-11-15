"""Write last week's insights for every café that has an owner: cafes/{id}/insights/{weekStart}.

Usage (from the repo root, venv active):
    python scripts/weekly_insights.py                       # last complete Monday-to-Sunday week
    python scripts/weekly_insights.py --week-start 2026-11-02
    python scripts/weekly_insights.py --cafe barbaras --dry-run     # print, write nothing
    python scripts/weekly_insights.py --no-model            # plain sentences, without the model server

The counts come from code (the events the brain logged). The model only words them, and its text is
replaced by the plain sentence if it states a number that isn't in the counts. Running it twice for the
same week replaces that week's documents.

Schedule it for Monday morning, for example (cron, server time zone = the café's):
    15 6 * * 1  cd /path/to/jolo && .venv/bin/python scripts/weekly_insights.py >> logs/insights.log 2>&1
The counts cover questions asked over iMessage only; activity inside the app is not included yet.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config                                      # noqa: E402
from jolo_agent.agent import ChatModel                                          # noqa: E402
from jolo_agent.insights import last_week_start, write_weekly_insights          # noqa: E402
from jolo_agent.store import open_store                                         # noqa: E402


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--week-start", type=date.fromisoformat, help="a Monday, YYYY-MM-DD (default: last week)")
    parser.add_argument("--cafe", help="only this café id")
    parser.add_argument("--dry-run", action="store_true", help="print the documents, write nothing")
    parser.add_argument("--no-model", action="store_true", help="plain sentences, no model call")
    args = parser.parse_args()

    config = load_config()
    timezone = config["agent"]["timezone"]
    week_start = args.week_start or last_week_start(tz=timezone)
    if week_start.weekday() != 0:
        sys.exit(f"{week_start} is not a Monday. The week starts on a Monday.")

    store = open_store(config)
    model = None if args.no_model else ChatModel(config)
    written = write_weekly_insights(store, week_start, model, timezone, only=args.cafe, dry_run=args.dry_run)
    if not written:
        sys.exit("No café with an owner" + (f" named {args.cafe!r}" if args.cafe else "") + ". Nothing to do.")
    for cafe_id, report in written.items():
        print(f"{cafe_id}: {report['counts']['customerQuestions']} questions, "
              f"{report['counts']['uniqueCustomers']} people. {report['summary']}")
        if args.dry_run:
            print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"{'Would write' if args.dry_run else 'Wrote'} {len(written)} insight document(s) for the week of {week_start}.")


if __name__ == "__main__":
    main()
