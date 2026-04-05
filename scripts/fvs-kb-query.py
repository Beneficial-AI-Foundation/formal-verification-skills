#!/usr/bin/env python3
"""FVS Knowledge Base Query Tool.

Composable tool for querying NotebookLM knowledge bases.
Called by fvs-researcher, fvs-executor, or directly by users.

Setup: /fvs:kb-setup (creates venv, installs notebooklm-py, runs login)

Usage:
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask "What is X?" --notebook <id>
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask "What is X?" --notebook <id> --text
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask "What is X?" --notebook <id> --source <id1> --source <id2>
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py list
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py health
"""

import asyncio
import sys
import json
import argparse

# --- Python version gate ---
if sys.version_info < (3, 10):
    print(
        json.dumps({
            "error": f"Python >= 3.10 required (running {sys.version_info.major}.{sys.version_info.minor}). "
                     "Use the venv: .formalising/.kb-venv/bin/python",
            "code": "PYTHON_TOO_OLD",
        }),
        file=sys.stdout,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

async def cmd_ask(notebook_id: str, question: str, source_ids: list[str] | None = None,
                  json_output: bool = True) -> dict:
    """Ask a question to a specific notebook."""
    try:
        from notebooklm import NotebookLMClient
    except ImportError:
        return {
            "error": "notebooklm-py not installed. Run /fvs:kb-setup",
            "code": "NOT_INSTALLED",
        }

    try:
        async with await NotebookLMClient.from_storage() as client:
            result = await client.chat.ask(
                notebook_id, question, source_ids=source_ids
            )
            if json_output:
                return {
                    "answer": result.answer,
                    "notebook_id": notebook_id,
                    "references": [
                        {
                            "source_id": r.source_id,
                            "citation_number": r.citation_number,
                            "cited_text": r.cited_text,
                        }
                        for r in (result.references or [])
                    ],
                    "conversation_id": result.conversation_id,
                }
            else:
                return {"answer": result.answer}
    except Exception as e:
        return _classify_error(e)


async def cmd_list() -> dict:
    """List all notebooks accessible to the authenticated user."""
    try:
        from notebooklm import NotebookLMClient
    except ImportError:
        return {
            "error": "notebooklm-py not installed. Run /fvs:kb-setup",
            "code": "NOT_INSTALLED",
        }

    try:
        async with await NotebookLMClient.from_storage() as client:
            notebooks = await client.notebooks.list()
            return {
                "notebooks": [
                    {"id": nb.id, "title": nb.title} for nb in notebooks
                ]
            }
    except Exception as e:
        return _classify_error(e)


async def cmd_health() -> dict:
    """Check that notebooklm-py is installed and authentication is valid."""
    try:
        from notebooklm import NotebookLMClient
    except ImportError:
        return {
            "status": "error",
            "message": "notebooklm-py not installed. Run /fvs:kb-setup",
        }

    try:
        async with await NotebookLMClient.from_storage() as client:
            await client.notebooks.list()
            return {"status": "ok", "message": "Authenticated and connected"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

def _classify_error(exc: Exception) -> dict:
    """Return a structured JSON error dict based on exception type."""
    name = type(exc).__name__
    if "Auth" in name:
        return {
            "error": "Auth expired. Run: .formalising/.kb-venv/bin/notebooklm login",
            "code": "AUTH_EXPIRED",
        }
    if "RateLimit" in name:
        return {
            "error": "Rate limited. Wait and retry.",
            "code": "RATE_LIMITED",
        }
    return {"error": str(exc), "code": "UNKNOWN"}


# ---------------------------------------------------------------------------
# CLI (argparse)
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fvs-kb-query",
        description="FVS Knowledge Base Query Tool -- query NotebookLM knowledge bases",
    )
    sub = parser.add_subparsers(dest="command")

    # --- ask ---
    ask_p = sub.add_parser("ask", help="Ask a question to a notebook")
    ask_p.add_argument("question", help="The question to ask")
    ask_p.add_argument(
        "--notebook", required=True, help="Notebook ID to query"
    )
    ask_p.add_argument(
        "--source", action="append", dest="sources", default=None,
        help="Filter to specific source IDs (repeatable)",
    )
    ask_p.add_argument(
        "--json", action="store_true", dest="json_flag",
        help="Output full JSON with references (default)",
    )
    ask_p.add_argument(
        "--text", action="store_true",
        help="Output plain text answer only",
    )

    # --- list ---
    sub.add_parser("list", help="List all accessible notebooks")

    # --- health ---
    sub.add_parser("health", help="Check installation and auth status")

    return parser


async def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "ask":
        # --text means plain text; default (or --json) means JSON
        json_output = not args.text
        result = await cmd_ask(
            notebook_id=args.notebook,
            question=args.question,
            source_ids=args.sources,
            json_output=json_output,
        )
    elif args.command == "list":
        result = await cmd_list()
    elif args.command == "health":
        result = await cmd_health()
    else:
        parser.print_help()
        return 1

    # Plain-text mode: emit just the answer string
    if args.command == "ask" and args.text and "answer" in result:
        print(result["answer"])
    else:
        print(json.dumps(result, indent=2))

    # Exit 1 on error, 0 on success
    if "error" in result or result.get("status") == "error":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
